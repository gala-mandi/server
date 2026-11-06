import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Role } from '../../common/auth/auth-user';
import type { RateUnit } from '../../common/charges/calculate-transaction';
import type { FieldError } from '../../common/filters/all-exceptions.filter';
import { karachiDate } from '../../common/time/karachi-date';
import { InvalidQuantityError } from '../../common/units/units';
import {
  commodities,
  purchaseCharges,
  purchaseItems,
  purchases,
  tenantSettings,
  traders,
} from '../../database/schema';
import {
  TenantDatabase,
  type TenantScope,
} from '../../database/tenant-database';
import {
  type CommodityCharges,
  effectiveCharges,
  type ManualCharges,
  SHOP_CHARGE_DEFAULTS,
  type ShopCharges,
  standardCharges,
} from '../commodities/effective-charges';
import { InvalidEntryError } from '../ledger/ledger-math';
import { LedgerReconciliation } from '../ledger/ledger-reconciliation.service';
import { LedgerService } from '../ledger/ledger.service';
import { nextNumber } from '../numbering/next-number';
import { likePattern, traderSearch } from '../traders/trader-search';
import {
  postPurchase,
  repostPurchase,
  reversePurchase,
} from './purchase-ledger';
import { DAY_CLOSED_MESSAGE, mayEditDay, savedRates } from './purchase-rules';
import { calculatePurchase, type PurchaseTotals } from './purchase-totals';
import type {
  CreatePurchaseInput,
  ListPurchasesQuery,
  ManualChargesInput,
  Purchase,
  PurchaseItemInput,
  PurchaseStatus,
  PurchaseSummary,
  UpdatePurchaseInput,
} from './purchases.dto';

type PurchaseRow = typeof purchases.$inferSelect;
type ItemRow = typeof purchaseItems.$inferSelect;
type ChargeRow = typeof purchaseCharges.$inferSelect;

/** Who is saving: the id goes on the rows, the role decides closed days. */
export interface Actor {
  id: string;
  role: Role;
}

/**
 * created_at of item and charge rows. `now()` is the same for a whole
 * transaction; the clock moves on between rows, so they keep their order.
 * (Drizzle's insert type has no room for SQL on a timestamp column.)
 */
const rowTime = sql`clock_timestamp()` as unknown as Date;

const IDEMPOTENCY_KEY_INDEX = 'purchases_tenant_id_idempotency_key_key';

const notFound = () => new NotFoundException('Purchase not found');

const invalid = (errors: FieldError[]) =>
  new BadRequestException({ message: 'Validation failed', errors });

const cancelled = () =>
  new ConflictException({
    message: 'This purchase is cancelled and cannot be changed',
    code: 'PURCHASE_CANCELLED',
  });

/** True for a unique violation of `constraint` (Postgres 23505). */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (const e of [error, (error as { cause?: unknown })?.cause]) {
    if (typeof e !== 'object' || e === null) continue;
    const c = e as { code?: unknown; constraint?: unknown };
    if (c.code === '23505') return c.constraint === constraint;
  }
  return false;
}

/** Rupees as stored: `net − (gross − deductions)`. */
export function roundingOf(
  row: Pick<PurchaseRow, 'grossAmount' | 'totalDeductions' | 'netAmount'>,
): string {
  return new Decimal(row.netAmount)
    .minus(row.grossAmount)
    .plus(row.totalDeductions)
    .toFixed(2);
}

export function toSummary(
  row: PurchaseRow,
  trader: { id: string; name: string },
): PurchaseSummary {
  return {
    id: row.id,
    billNo: row.billNo,
    purchaseDate: row.purchaseDate,
    trader,
    grossAmount: row.grossAmount,
    totalDeductions: row.totalDeductions,
    rounding: roundingOf(row),
    netAmount: row.netAmount,
    paidAmount: row.paidAmount,
    status: row.status,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A purchase date as a moment, for the financial year of its bill number. */
const dayAt = (date: string) => new Date(`${date}T12:00:00+05:00`);

/** A calculator/khata error, as a field error the form can show. */
function asBadRequest(error: unknown): never {
  if (error instanceof InvalidQuantityError) {
    throw invalid([
      {
        field: error.field,
        message: error.message.slice(error.field.length + 2),
      },
    ]);
  }
  if (error instanceof InvalidEntryError) {
    throw new BadRequestException(error.message);
  }
  throw error;
}

interface Shop extends ShopCharges {
  maundKg: string;
}

/** A purchase's lines as the calculator and the item rows need them. */
interface Line extends Omit<PurchaseItemInput, 'rateUnit'> {
  rateUnit: RateUnit;
}

/** What `calculate()` saves: the totals plus the lines they came from. */
interface Calculated {
  lines: Line[];
  totals: PurchaseTotals;
}

/**
 * Purchases from kissans. A save writes the purchase, its items and charges,
 * its bill number and its khata lines in one transaction: all or nothing.
 * The khata is never edited: edits and cancels reverse and re-post.
 */
@Injectable()
export class PurchasesService implements OnModuleInit {
  constructor(
    private readonly db: TenantDatabase,
    private readonly ledger: LedgerService,
    private readonly reconciliation: LedgerReconciliation,
  ) {}

  onModuleInit(): void {
    // Each purchase must hold paid − net in the kissan's khata (debit minus
    // credit); a cancelled one 0.
    this.reconciliation.register({
      sourceType: 'purchase',
      expected: sql`
        select ${purchases.tenantId} as tenant_id,
               ${purchases.traderId} as trader_id,
               ${purchases.id} as source_id,
               case when ${purchases.status} = 'posted'
                    then ${purchases.paidAmount} - ${purchases.netAmount}
                    else 0 end as net
          from ${purchases}`,
    });
  }

  /**
   * Saves a new purchase, or returns the one already saved with this
   * `Idempotency-Key` (double click, retry after a lost response).
   */
  async create(
    input: CreatePurchaseInput,
    actor: Actor,
    idempotencyKey: string,
    now: Date = new Date(),
  ): Promise<{ purchase: Purchase; replayed: boolean }> {
    const earlier = await this.findByKey(idempotencyKey);
    if (earlier) return { purchase: earlier, replayed: true };
    try {
      const purchase = await this.db.transaction((scope) =>
        this.insert(scope, input, actor, idempotencyKey, now),
      );
      return { purchase, replayed: false };
    } catch (error) {
      // The same key at the same moment: the other save won, this one rolled
      // back (and gave its bill number back).
      if (isUniqueViolation(error, IDEMPOTENCY_KEY_INDEX)) {
        const winner = await this.findByKey(idempotencyKey);
        if (winner) return { purchase: winner, replayed: true };
      }
      throw error;
    }
  }

  async list(query: ListPurchasesQuery) {
    return this.db.transaction(async ({ tx, scoped }) => {
      const filters: SQL[] = [];
      if (query.from) filters.push(gte(purchases.purchaseDate, query.from));
      if (query.to) filters.push(lte(purchases.purchaseDate, query.to));
      if (query.trader) filters.push(eq(purchases.traderId, query.trader));
      if (query.status) filters.push(eq(purchases.status, query.status));
      if (query.commodity) {
        filters.push(
          exists(
            tx
              .select({ one: sql`1` })
              .from(purchaseItems)
              .where(
                scoped(purchaseItems).where(
                  and(
                    eq(purchaseItems.purchaseId, purchases.id),
                    eq(purchaseItems.commodityId, query.commodity),
                  ),
                ),
              ),
          ),
        );
      }
      if (query.search) {
        filters.push(
          or(
            ilike(purchases.billNo, likePattern(query.search)),
            traderSearch(query.search),
          )!,
        );
      }
      const where = scoped(purchases).where(and(...filters));
      const order = {
        purchaseDate: [asc(purchases.purchaseDate), asc(purchases.billNo)],
        '-purchaseDate': [desc(purchases.purchaseDate), desc(purchases.billNo)],
        billNo: [asc(purchases.billNo)],
        '-billNo': [desc(purchases.billNo)],
      }[query.sort];
      // Traders are joined with deleted ones: an old bill keeps its name.
      const join = and(
        eq(traders.id, purchases.traderId),
        eq(traders.tenantId, purchases.tenantId),
      );

      const [rows, [{ total }]] = await Promise.all([
        tx
          .select({
            purchase: purchases,
            trader: { id: traders.id, name: traders.name },
          })
          .from(purchases)
          .innerJoin(traders, join)
          .where(where)
          .orderBy(...order, asc(purchases.id))
          .limit(query.limit)
          .offset((query.page - 1) * query.limit),
        tx
          .select({ total: count() })
          .from(purchases)
          .innerJoin(traders, join)
          .where(where),
      ]);
      return {
        data: rows.map((r) => toSummary(r.purchase, r.trader)),
        meta: { page: query.page, limit: query.limit, total },
      };
    });
  }

  get(id: string): Promise<Purchase> {
    return this.db.transaction(async (scope) => {
      const row = await scope.scoped(purchases).findById(id);
      if (!row) throw notFound();
      return this.detail(scope, row);
    });
  }

  /**
   * Changes a purchase and corrects the khata (reverse, re-post). Days
   * before today are the owner's only. Every change is audited with its old
   * values.
   */
  update(
    id: string,
    input: UpdatePurchaseInput,
    actor: Actor,
    now: Date = new Date(),
  ): Promise<Purchase> {
    return this.db.transaction(async (scope) => {
      const before = await this.lock(scope, id);
      if (before.status === 'cancelled') throw cancelled();

      const today = karachiDate(now);
      const date = input.purchaseDate ?? before.purchaseDate;
      if (!mayEditDay(actor.role, before.purchaseDate, date, today)) {
        throw new ForbiddenException({
          message: DAY_CLOSED_MESSAGE,
          code: 'DAY_CLOSED',
        });
      }
      this.checkDate(date, today);

      const errors: FieldError[] = [];
      if (input.traderId && input.traderId !== before.traderId) {
        errors.push(...(await this.checkTrader(scope, input.traderId)));
      }

      const recalculate =
        input.items !== undefined || input.charges !== undefined;
      const old = recalculate ? await this.linesOf(scope, id) : null;
      let calculated: Calculated | null = null;
      if (old) {
        const lines = input.items ?? old.items.map(toLine);
        // Commodities already on the bill may since have been deactivated.
        const onBill = new Set(old.items.map((i) => i.commodityId));
        const known = await this.checkCommodities(scope, lines, onBill, errors);
        if (errors.length) throw invalid(errors);
        // The bill's own rates, unless this edit sets them.
        const manual: ManualCharges = {
          ...savedRates(old.charges),
          ...definedOnly(input.charges ?? {}),
        };
        calculated = await this.calculate(scope, lines, known, manual);
      } else if (errors.length) {
        throw invalid(errors);
      }

      const netAmount = calculated?.totals.netAmount ?? before.netAmount;
      const paidAmount = input.paidAmount ?? before.paidAmount;
      this.checkPaid(paidAmount, netAmount);

      const changes = Object.fromEntries(
        Object.entries({
          traderId: input.traderId,
          purchaseDate: input.purchaseDate,
          paidAmount:
            input.paidAmount === undefined
              ? undefined
              : new Decimal(input.paidAmount).toFixed(2),
          notes: input.notes,
          ...(calculated && {
            grossAmount: calculated.totals.grossAmount,
            totalDeductions: calculated.totals.totalDeductions,
            netAmount,
          }),
        }).filter(([, v]) => v !== undefined),
      );
      const after = Object.keys(changes).length
        ? ((await scope.scoped(purchases).update(id, changes)) ?? before)
        : before;

      if (old && calculated) {
        // The old lines stay in the table, soft-deleted and audited with
        // their values; the recalculated ones replace them.
        for (const item of old.items) {
          await scope.scoped(purchaseItems).softDelete(item.id);
        }
        for (const charge of old.charges) {
          await scope.scoped(purchaseCharges).softDelete(charge.id);
        }
        await this.insertLines(scope, id, calculated, actor.id);
      }

      try {
        await repostPurchase(this.ledger, scope, before, after, actor.id);
      } catch (error) {
        asBadRequest(error);
      }
      return this.detail(scope, after);
    });
  }

  /**
   * Cancels instead of deleting: the khata lines are reversed (dated today),
   * the bill keeps its number and stays readable.
   */
  cancel(id: string, actor: Actor): Promise<Purchase> {
    return this.db.transaction(async (scope) => {
      const before = await this.lock(scope, id);
      if (before.status === 'cancelled') throw cancelled();
      const after =
        (await scope
          .scoped(purchases)
          .update(id, { status: 'cancelled' satisfies PurchaseStatus })) ??
        before;
      await reversePurchase(this.ledger, scope, before, actor.id);
      return this.detail(scope, after);
    });
  }

  /* ---------------------------------------------------------------- */

  private async insert(
    scope: TenantScope,
    input: CreatePurchaseInput,
    actor: Actor,
    idempotencyKey: string,
    now: Date,
  ): Promise<Purchase> {
    const today = karachiDate(now);
    const date = input.purchaseDate ?? today;
    this.checkDate(date, today);

    const errors = await this.checkTrader(scope, input.traderId);
    const known = await this.checkCommodities(
      scope,
      input.items,
      new Set(),
      errors,
    );
    if (errors.length) throw invalid(errors);

    const calculated = await this.calculate(
      scope,
      input.items,
      known,
      definedOnly(input.charges),
    );
    const { totals } = calculated;
    this.checkPaid(input.paidAmount, totals.netAmount);

    // Last before the inserts: a failed save rolls the number back too.
    const bill = await nextNumber(scope, 'purchase', dayAt(date));
    // The scoped helper overwrites tenant_id; it never comes from the body.
    const values: typeof purchases.$inferInsert = {
      tenantId: scope.tenantId,
      billNo: bill.billNo,
      traderId: input.traderId,
      purchaseDate: date,
      grossAmount: totals.grossAmount,
      totalDeductions: totals.totalDeductions,
      netAmount: totals.netAmount,
      paidAmount: new Decimal(input.paidAmount).toFixed(2),
      status: 'posted',
      notes: input.notes,
      idempotencyKey,
      createdBy: actor.id,
    };
    const [row] = await scope.scoped(purchases).insert(values);
    await this.insertLines(scope, row.id, calculated, actor.id);
    try {
      await postPurchase(this.ledger, scope, row, actor.id);
    } catch (error) {
      asBadRequest(error);
    }
    return this.detail(scope, row);
  }

  /** Item and charge rows, in parchi order. */
  private async insertLines(
    scope: TenantScope,
    purchaseId: string,
    { lines, totals }: Calculated,
    userId: string,
  ): Promise<void> {
    // One row at a time with clock_timestamp(): created_at keeps their order.
    for (const [i, line] of lines.entries()) {
      const item: typeof purchaseItems.$inferInsert = {
        tenantId: scope.tenantId,
        purchaseId,
        commodityId: line.commodityId,
        bags: line.bags,
        weightKg: new Decimal(line.weightKg).toFixed(3),
        rate: new Decimal(line.rate).toFixed(2),
        rateUnit: line.rateUnit,
        amount: totals.itemAmounts[i],
        createdBy: userId,
        createdAt: rowTime,
      };
      await scope.scoped(purchaseItems).insert(item);
    }
    for (const charge of totals.charges) {
      const row: typeof purchaseCharges.$inferInsert = {
        tenantId: scope.tenantId,
        purchaseId,
        ...charge,
        createdBy: userId,
        createdAt: rowTime,
      };
      await scope.scoped(purchaseCharges).insert(row);
    }
  }

  /** Runs the calculator over the lines with each commodity's charges. */
  private async calculate(
    scope: TenantScope,
    lines: readonly Line[],
    known: Map<string, CommodityCharges>,
    manual: ManualCharges,
  ): Promise<Calculated> {
    const shop = await this.shop(scope);
    try {
      const totals = calculatePurchase(
        lines.map((line) => ({
          weightKg: line.weightKg,
          rate: line.rate,
          rateUnit: line.rateUnit,
          bags: line.bags,
          charges: standardCharges(
            effectiveCharges(known.get(line.commodityId)!, shop, manual),
          ),
        })),
        shop.maundKg,
      );
      return { lines: [...lines], totals };
    } catch (error) {
      asBadRequest(error);
    }
  }

  /** Never in the future; earlier days are late entries of paper bills. */
  private checkDate(date: string, today: string): void {
    if (date > today) {
      throw invalid([
        {
          field: 'purchaseDate',
          message: 'A purchase cannot be dated in the future',
        },
      ]);
    }
  }

  private checkPaid(paid: string, net: string): void {
    if (new Decimal(paid).greaterThan(net)) {
      throw invalid([
        {
          field: 'paidAmount',
          message: `The amount paid cannot be more than the net amount (Rs ${net})`,
        },
      ]);
    }
  }

  /** An active kissan of this shop (another shop's looks unknown). */
  private async checkTrader(
    { scoped }: TenantScope,
    traderId: string,
  ): Promise<FieldError[]> {
    const trader = await scoped(traders).findById(traderId);
    const message = !trader
      ? 'Kissan not found'
      : trader.type !== 'kissan'
        ? 'Choose a kissan (farmer); this trader is not one'
        : !trader.isActive
          ? 'This kissan is inactive'
          : null;
    return message ? [{ field: 'traderId', message }] : [];
  }

  /**
   * Every line's commodity must be in this shop and active (`allowed`
   * skips the active check). Adds field errors; returns the charges of the
   * commodities found.
   */
  private async checkCommodities(
    { tx, scoped }: TenantScope,
    lines: readonly Line[],
    allowed: Set<string>,
    errors: FieldError[],
  ): Promise<Map<string, CommodityCharges>> {
    const ids = [...new Set(lines.map((l) => l.commodityId))];
    const rows = await tx
      .select()
      .from(commodities)
      .where(scoped(commodities).where(inArray(commodities.id, ids)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    lines.forEach((line, i) => {
      const row = byId.get(line.commodityId);
      const message = !row
        ? 'Commodity not found'
        : !row.isActive && !allowed.has(row.id)
          ? 'This commodity is inactive'
          : null;
      if (message) errors.push({ field: `items.${i}.commodityId`, message });
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Shop defaults; a shop without a settings row has the column defaults. */
  private async shop({ tx, tenantId }: TenantScope): Promise<Shop> {
    const [row] = await tx
      .select({
        defaultCommissionPct: tenantSettings.defaultCommissionPct,
        marketFeePct: tenantSettings.marketFeePct,
        labourPerBag: tenantSettings.labourPerBag,
        maundKg: tenantSettings.maundKg,
      })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId))
      .limit(1);
    return row ?? { ...SHOP_CHARGE_DEFAULTS, maundKg: '40' };
  }

  /** The purchase, locked until the transaction ends (edit and cancel). */
  private async lock({ tx, scoped }: TenantScope, id: string) {
    const [row] = await tx
      .select()
      .from(purchases)
      .where(scoped(purchases).byId(id))
      .for('update');
    if (!row) throw notFound();
    return row;
  }

  private async linesOf({ tx, scoped }: TenantScope, purchaseId: string) {
    const [items, charges] = await Promise.all([
      tx
        .select()
        .from(purchaseItems)
        .where(
          scoped(purchaseItems).where(eq(purchaseItems.purchaseId, purchaseId)),
        )
        .orderBy(asc(purchaseItems.createdAt), asc(purchaseItems.id)),
      tx
        .select()
        .from(purchaseCharges)
        .where(
          scoped(purchaseCharges).where(
            eq(purchaseCharges.purchaseId, purchaseId),
          ),
        )
        .orderBy(asc(purchaseCharges.createdAt), asc(purchaseCharges.id)),
    ]);
    return { items, charges };
  }

  private async findByKey(key: string): Promise<Purchase | null> {
    return this.db.transaction(async (scope) => {
      const [row] = await scope.tx
        .select()
        .from(purchases)
        .where(
          and(
            eq(purchases.tenantId, scope.tenantId),
            isNull(purchases.deletedAt),
            eq(purchases.idempotencyKey, key),
          ),
        )
        .limit(1);
      return row ? this.detail(scope, row) : null;
    });
  }

  private async detail(
    scope: TenantScope,
    row: PurchaseRow,
  ): Promise<Purchase> {
    const { tx, tenantId } = scope;
    const [[trader], { items, charges }, names] = await Promise.all([
      // Deleted traders included: an old bill keeps its name.
      tx
        .select({ id: traders.id, name: traders.name })
        .from(traders)
        .where(
          and(eq(traders.tenantId, tenantId), eq(traders.id, row.traderId)),
        ),
      this.linesOf(scope, row.id),
      tx
        .select({ id: commodities.id, name: commodities.name })
        .from(commodities)
        .innerJoin(
          purchaseItems,
          and(
            eq(purchaseItems.commodityId, commodities.id),
            eq(purchaseItems.purchaseId, row.id),
          ),
        )
        .where(eq(commodities.tenantId, tenantId)),
    ]);
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    return {
      ...toSummary(row, trader),
      items: items.map((item) => toItem(item, nameOf.get(item.commodityId))),
      charges: charges.map(toCharge),
      createdBy: row.createdBy,
    };
  }
}

/** Drops keys that are `undefined` (not sent), keeps `null` (reset). */
function definedOnly(charges: ManualChargesInput): ManualCharges {
  return Object.fromEntries(
    Object.entries(charges).filter(([, v]) => v !== undefined),
  );
}

function toLine(item: ItemRow): Line {
  return {
    commodityId: item.commodityId,
    bags: item.bags,
    weightKg: item.weightKg,
    rate: item.rate,
    rateUnit: item.rateUnit as RateUnit,
  };
}

export function toItem(
  item: ItemRow,
  commodityName = '',
): Purchase['items'][number] {
  return {
    id: item.id,
    commodityId: item.commodityId,
    commodityName,
    bags: item.bags,
    weightKg: item.weightKg,
    rate: item.rate,
    rateUnit: item.rateUnit as RateUnit,
    amount: item.amount,
  };
}

export function toCharge(charge: ChargeRow): Purchase['charges'][number] {
  return {
    id: charge.id,
    type: charge.type as Purchase['charges'][number]['type'],
    basis: charge.basis as Purchase['charges'][number]['basis'],
    value: charge.value,
    amount: charge.amount,
  };
}
