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
import type { RateUnit } from '../../common/charges/calculate-transaction';
import type { FieldError } from '../../common/filters/all-exceptions.filter';
import { karachiDate } from '../../common/time/karachi-date';
import { InvalidQuantityError } from '../../common/units/units';
import {
  commodities,
  purchaseItems,
  purchases,
  saleCharges,
  saleItems,
  sales,
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
import { type Actor, isUniqueViolation } from '../purchases/purchases.service';
import { likePattern, traderSearch } from '../traders/trader-search';
import { postSale, repostSale, reverseSale } from './sale-ledger';
import {
  CREDIT_LIMIT_EXCEEDED,
  type CreditLimitAction,
  creditLimitMessage,
  DAY_CLOSED_MESSAGE,
  mayEditDay,
  overCreditLimit,
  savedRates,
} from './sale-rules';
import { calculateSale, type SaleTotals } from './sale-totals';
import type {
  CreateSaleInput,
  ListSalesQuery,
  Sale,
  SaleItemInput,
  SaleStatus,
  SaleSummary,
  SaleWarning,
  SavedSale,
  UpdateSaleInput,
} from './sales.dto';

export type { Actor };

type SaleRow = typeof sales.$inferSelect;
type ItemRow = typeof saleItems.$inferSelect;
type ChargeRow = typeof saleCharges.$inferSelect;

/**
 * created_at of item and charge rows. `now()` is the same for a whole
 * transaction; the clock moves on between rows, so they keep their order.
 */
const rowTime = sql`clock_timestamp()` as unknown as Date;

const IDEMPOTENCY_KEY_INDEX = 'sales_tenant_id_idempotency_key_key';

const notFound = () => new NotFoundException('Sale not found');

const invalid = (errors: FieldError[]) =>
  new BadRequestException({ message: 'Validation failed', errors });

const cancelled = () =>
  new ConflictException({
    message: 'This sale is cancelled and cannot be changed',
    code: 'SALE_CANCELLED',
  });

/** Rupees as stored: `net − (gross + charges)`. */
export function roundingOf(
  row: Pick<SaleRow, 'grossAmount' | 'totalCharges' | 'netAmount'>,
): string {
  return new Decimal(row.netAmount)
    .minus(row.grossAmount)
    .minus(row.totalCharges)
    .toFixed(2);
}

export function toSummary(
  row: SaleRow,
  buyer: { id: string; name: string },
): SaleSummary {
  return {
    id: row.id,
    billNo: row.billNo,
    saleDate: row.saleDate,
    buyer,
    grossAmount: row.grossAmount,
    totalCharges: row.totalCharges,
    rounding: roundingOf(row),
    netAmount: row.netAmount,
    receivedAmount: row.receivedAmount,
    status: row.status,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A sale date as a moment, for the financial year of its bill number. */
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
  creditLimitAction: CreditLimitAction;
}

/** A sale's lines as the calculator and the item rows need them. */
interface Line extends Omit<SaleItemInput, 'rateUnit'> {
  rateUnit: RateUnit;
}

interface Calculated {
  lines: Line[];
  totals: SaleTotals;
}

/** The buyer as the credit check needs them. */
interface Buyer {
  id: string;
  name: string;
  creditLimit: string | null;
}

/**
 * Sales to beoparis. A save writes the sale, its items and charges, its bill
 * number and its khata lines in one transaction: all or nothing. The khata
 * is never edited: edits and cancels reverse and re-post.
 */
@Injectable()
export class SalesService implements OnModuleInit {
  constructor(
    private readonly db: TenantDatabase,
    private readonly ledger: LedgerService,
    private readonly reconciliation: LedgerReconciliation,
  ) {}

  onModuleInit(): void {
    // Each sale must hold net − received in the beopari's khata (debit minus
    // credit); a cancelled one 0.
    this.reconciliation.register({
      sourceType: 'sale',
      expected: sql`
        select ${sales.tenantId} as tenant_id,
               ${sales.buyerId} as trader_id,
               ${sales.id} as source_id,
               case when ${sales.status} = 'posted'
                    then ${sales.netAmount} - ${sales.receivedAmount}
                    else 0 end as net
          from ${sales}`,
    });
  }

  /**
   * Saves a new sale, or returns the one already saved with this
   * `Idempotency-Key` (double click, retry after a lost response).
   */
  async create(
    input: CreateSaleInput,
    actor: Actor,
    idempotencyKey: string,
    now: Date = new Date(),
  ): Promise<{ sale: SavedSale; replayed: boolean }> {
    const earlier = await this.findByKey(idempotencyKey);
    if (earlier) return { sale: { ...earlier, warnings: [] }, replayed: true };
    try {
      const sale = await this.db.transaction((scope) =>
        this.insert(scope, input, actor, idempotencyKey, now),
      );
      return { sale, replayed: false };
    } catch (error) {
      // The same key at the same moment: the other save won, this one rolled
      // back (and gave its bill number back).
      if (isUniqueViolation(error, IDEMPOTENCY_KEY_INDEX)) {
        const winner = await this.findByKey(idempotencyKey);
        if (winner) {
          return { sale: { ...winner, warnings: [] }, replayed: true };
        }
      }
      throw error;
    }
  }

  async list(query: ListSalesQuery) {
    return this.db.transaction(async ({ tx, scoped }) => {
      const filters: SQL[] = [];
      if (query.from) filters.push(gte(sales.saleDate, query.from));
      if (query.to) filters.push(lte(sales.saleDate, query.to));
      if (query.buyer) filters.push(eq(sales.buyerId, query.buyer));
      if (query.status) filters.push(eq(sales.status, query.status));
      if (query.commodity) {
        filters.push(
          exists(
            tx
              .select({ one: sql`1` })
              .from(saleItems)
              .where(
                scoped(saleItems).where(
                  and(
                    eq(saleItems.saleId, sales.id),
                    eq(saleItems.commodityId, query.commodity),
                  ),
                ),
              ),
          ),
        );
      }
      if (query.search) {
        filters.push(
          or(
            ilike(sales.billNo, likePattern(query.search)),
            traderSearch(query.search),
          )!,
        );
      }
      const where = scoped(sales).where(and(...filters));
      const order = {
        saleDate: [asc(sales.saleDate), asc(sales.billNo)],
        '-saleDate': [desc(sales.saleDate), desc(sales.billNo)],
        billNo: [asc(sales.billNo)],
        '-billNo': [desc(sales.billNo)],
      }[query.sort];
      // Traders are joined with deleted ones: an old bill keeps its name.
      const join = and(
        eq(traders.id, sales.buyerId),
        eq(traders.tenantId, sales.tenantId),
      );

      const [rows, [{ total }]] = await Promise.all([
        tx
          .select({
            sale: sales,
            buyer: { id: traders.id, name: traders.name },
          })
          .from(sales)
          .innerJoin(traders, join)
          .where(where)
          .orderBy(...order, asc(sales.id))
          .limit(query.limit)
          .offset((query.page - 1) * query.limit),
        tx
          .select({ total: count() })
          .from(sales)
          .innerJoin(traders, join)
          .where(where),
      ]);
      return {
        data: rows.map((r) => toSummary(r.sale, r.buyer)),
        meta: { page: query.page, limit: query.limit, total },
      };
    });
  }

  get(id: string): Promise<Sale> {
    return this.db.transaction(async (scope) => {
      const row = await scope.scoped(sales).findById(id);
      if (!row) throw notFound();
      return this.detail(scope, row);
    });
  }

  /**
   * Changes a sale and corrects the khata (reverse, re-post). Days before
   * today are the owner's only. Every change is audited with its old values.
   */
  update(
    id: string,
    input: UpdateSaleInput,
    actor: Actor,
    now: Date = new Date(),
  ): Promise<SavedSale> {
    return this.db.transaction(async (scope) => {
      const before = await this.lock(scope, id);
      if (before.status === 'cancelled') throw cancelled();

      const today = karachiDate(now);
      const date = input.saleDate ?? before.saleDate;
      if (!mayEditDay(actor.role, before.saleDate, date, today)) {
        throw new ForbiddenException({
          message: DAY_CLOSED_MESSAGE,
          code: 'DAY_CLOSED',
        });
      }
      this.checkDate(date, today);

      const errors: FieldError[] = [];
      if (input.buyerId && input.buyerId !== before.buyerId) {
        errors.push(...(await this.checkBuyer(scope, input.buyerId)).errors);
      }

      const recalculate =
        input.items !== undefined || input.charges !== undefined;
      const old = recalculate ? await this.linesOf(scope, id) : null;
      let calculated: Calculated | null = null;
      if (old) {
        const lines = input.items ?? old.items.map(toLine);
        // Commodities and lots already on the bill may stay, even if the
        // commodity was deactivated or the lot's purchase changed since.
        const onBill = new Set(old.items.map((i) => i.commodityId));
        const lotsOnBill = new Set(
          old.items.flatMap((i) =>
            i.purchaseItemId ? [i.purchaseItemId] : [],
          ),
        );
        const known = await this.checkCommodities(scope, lines, onBill, errors);
        await this.checkLots(scope, lines, lotsOnBill, errors);
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
      const receivedAmount = input.receivedAmount ?? before.receivedAmount;
      this.checkReceived(receivedAmount, netAmount);

      const changes = Object.fromEntries(
        Object.entries({
          buyerId: input.buyerId,
          saleDate: input.saleDate,
          receivedAmount:
            input.receivedAmount === undefined
              ? undefined
              : new Decimal(input.receivedAmount).toFixed(2),
          notes: input.notes,
          ...(calculated && {
            grossAmount: calculated.totals.grossAmount,
            totalCharges: calculated.totals.totalCharges,
            netAmount,
          }),
        }).filter(([, v]) => v !== undefined),
      );
      const after = Object.keys(changes).length
        ? ((await scope.scoped(sales).update(id, changes)) ?? before)
        : before;

      if (old && calculated) {
        // The old lines stay in the table, soft-deleted and audited with
        // their values; the recalculated ones replace them.
        for (const item of old.items) {
          await scope.scoped(saleItems).softDelete(item.id);
        }
        for (const charge of old.charges) {
          await scope.scoped(saleCharges).softDelete(charge.id);
        }
        await this.insertLines(scope, id, calculated, actor.id);
      }

      const owedBefore = await this.ledger.balance(scope, after.buyerId);
      let reposted = false;
      try {
        reposted = await repostSale(
          this.ledger,
          scope,
          before,
          after,
          actor.id,
        );
      } catch (error) {
        asBadRequest(error);
      }
      const warnings = reposted
        ? await this.checkCredit(scope, after.buyerId, owedBefore)
        : [];
      return { ...(await this.detail(scope, after)), warnings };
    });
  }

  /**
   * Cancels instead of deleting: the khata lines are reversed (dated today),
   * the bill keeps its number and stays readable.
   */
  cancel(id: string, actor: Actor): Promise<Sale> {
    return this.db.transaction(async (scope) => {
      const before = await this.lock(scope, id);
      if (before.status === 'cancelled') throw cancelled();
      const after =
        (await scope
          .scoped(sales)
          .update(id, { status: 'cancelled' satisfies SaleStatus })) ?? before;
      await reverseSale(this.ledger, scope, before, actor.id);
      return this.detail(scope, after);
    });
  }

  /* ---------------------------------------------------------------- */

  private async insert(
    scope: TenantScope,
    input: CreateSaleInput,
    actor: Actor,
    idempotencyKey: string,
    now: Date,
  ): Promise<SavedSale> {
    const today = karachiDate(now);
    const date = input.saleDate ?? today;
    this.checkDate(date, today);

    const { errors } = await this.checkBuyer(scope, input.buyerId);
    const known = await this.checkCommodities(
      scope,
      input.items,
      new Set(),
      errors,
    );
    await this.checkLots(scope, input.items, new Set(), errors);
    if (errors.length) throw invalid(errors);

    const calculated = await this.calculate(
      scope,
      input.items,
      known,
      definedOnly(input.charges),
    );
    const { totals } = calculated;
    this.checkReceived(input.receivedAmount, totals.netAmount);

    const owedBefore = await this.ledger.balance(scope, input.buyerId);
    // Last before the inserts: a failed save rolls the number back too.
    const bill = await nextNumber(scope, 'sale', dayAt(date));
    // The scoped helper overwrites tenant_id; it never comes from the body.
    const values: typeof sales.$inferInsert = {
      tenantId: scope.tenantId,
      billNo: bill.billNo,
      buyerId: input.buyerId,
      saleDate: date,
      grossAmount: totals.grossAmount,
      totalCharges: totals.totalCharges,
      netAmount: totals.netAmount,
      receivedAmount: new Decimal(input.receivedAmount).toFixed(2),
      status: 'posted',
      notes: input.notes,
      idempotencyKey,
      createdBy: actor.id,
    };
    const [row] = await scope.scoped(sales).insert(values);
    await this.insertLines(scope, row.id, calculated, actor.id);
    try {
      await postSale(this.ledger, scope, row, actor.id);
    } catch (error) {
      asBadRequest(error);
    }
    // Throws (and so rolls everything back) when the shop blocks.
    const warnings = await this.checkCredit(scope, row.buyerId, owedBefore);
    return { ...(await this.detail(scope, row)), warnings };
  }

  /**
   * The credit limit check, after the khata lines are written: when the
   * save raised what the buyer owes above their `credit_limit`, a warning,
   * or a 409 `CREDIT_LIMIT_EXCEEDED` (which rolls the save back) when the
   * shop's `credit_limit_action` is `block`.
   */
  private async checkCredit(
    scope: TenantScope,
    buyerId: string,
    owedBefore: string,
  ): Promise<SaleWarning[]> {
    const [buyer, shop] = await Promise.all([
      this.buyerOf(scope, buyerId),
      this.shop(scope),
    ]);
    if (!buyer || buyer.creditLimit === null) return [];
    const balance = await this.ledger.balance(scope, buyerId);
    const check = {
      creditLimit: buyer.creditLimit,
      before: owedBefore,
      after: balance,
    };
    if (!overCreditLimit(check)) return [];
    const message = creditLimitMessage(buyer.name, balance, buyer.creditLimit);
    if (shop.creditLimitAction === 'block') {
      throw new ConflictException({
        message,
        code: CREDIT_LIMIT_EXCEEDED,
        errors: [{ field: 'buyerId', message }],
      });
    }
    return [
      {
        code: CREDIT_LIMIT_EXCEEDED,
        message,
        balance: new Decimal(balance).toFixed(2),
        creditLimit: buyer.creditLimit,
      },
    ];
  }

  /** Item and charge rows, in parchi order. */
  private async insertLines(
    scope: TenantScope,
    saleId: string,
    { lines, totals }: Calculated,
    userId: string,
  ): Promise<void> {
    // One row at a time with clock_timestamp(): created_at keeps their order.
    for (const [i, line] of lines.entries()) {
      const item: typeof saleItems.$inferInsert = {
        tenantId: scope.tenantId,
        saleId,
        commodityId: line.commodityId,
        purchaseItemId: line.purchaseItemId,
        bags: line.bags,
        weightKg: new Decimal(line.weightKg).toFixed(3),
        rate: new Decimal(line.rate).toFixed(2),
        rateUnit: line.rateUnit,
        amount: totals.itemAmounts[i],
        createdBy: userId,
        createdAt: rowTime,
      };
      await scope.scoped(saleItems).insert(item);
    }
    for (const charge of totals.charges) {
      const row: typeof saleCharges.$inferInsert = {
        tenantId: scope.tenantId,
        saleId,
        ...charge,
        createdBy: userId,
        createdAt: rowTime,
      };
      await scope.scoped(saleCharges).insert(row);
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
      const totals = calculateSale(
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
        { field: 'saleDate', message: 'A sale cannot be dated in the future' },
      ]);
    }
  }

  private checkReceived(received: string, net: string): void {
    if (new Decimal(received).greaterThan(net)) {
      throw invalid([
        {
          field: 'receivedAmount',
          message: `The amount received cannot be more than the net amount (Rs ${net})`,
        },
      ]);
    }
  }

  /** An active beopari of this shop (another shop's looks unknown). */
  private async checkBuyer(
    { scoped }: TenantScope,
    buyerId: string,
  ): Promise<{ errors: FieldError[] }> {
    const trader = await scoped(traders).findById(buyerId);
    const message = !trader
      ? 'Beopari not found'
      : trader.type !== 'beopari'
        ? 'Choose a beopari (buyer); this trader is not one'
        : !trader.isActive
          ? 'This beopari is inactive'
          : null;
    return { errors: message ? [{ field: 'buyerId', message }] : [] };
  }

  /** Name and limit of a trader of this shop, deleted ones included. */
  private async buyerOf(
    { tx, tenantId }: TenantScope,
    id: string,
  ): Promise<Buyer | null> {
    const [row] = await tx
      .select({
        id: traders.id,
        name: traders.name,
        creditLimit: traders.creditLimit,
      })
      .from(traders)
      .where(and(eq(traders.tenantId, tenantId), eq(traders.id, id)))
      .limit(1);
    return row ?? null;
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

  /**
   * A linked lot must be a purchase item of this shop, of the same
   * commodity, on a purchase that is not cancelled. Lots already on the bill
   * (`allowed`) only need the commodity to match: the purchase may have been
   * edited or cancelled since.
   */
  private async checkLots(
    { tx, tenantId }: TenantScope,
    lines: readonly Line[],
    allowed: Set<string>,
    errors: FieldError[],
  ): Promise<void> {
    const ids = [
      ...new Set(
        lines.flatMap((l) => (l.purchaseItemId ? [l.purchaseItemId] : [])),
      ),
    ];
    if (!ids.length) return;
    // Deleted rows included, for the lots already on the bill.
    const rows = await tx
      .select({
        id: purchaseItems.id,
        commodityId: purchaseItems.commodityId,
        itemDeleted: purchaseItems.deletedAt,
        purchaseDeleted: purchases.deletedAt,
        status: purchases.status,
      })
      .from(purchaseItems)
      .innerJoin(
        purchases,
        and(
          eq(purchases.id, purchaseItems.purchaseId),
          eq(purchases.tenantId, purchaseItems.tenantId),
        ),
      )
      .where(
        and(
          eq(purchaseItems.tenantId, tenantId),
          inArray(purchaseItems.id, ids),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    lines.forEach((line, i) => {
      if (!line.purchaseItemId) return;
      const lot = byId.get(line.purchaseItemId);
      const onBill = allowed.has(line.purchaseItemId);
      const message =
        !lot || (!onBill && (lot.itemDeleted || lot.purchaseDeleted))
          ? 'Lot not found'
          : lot.commodityId !== line.commodityId
            ? 'This lot is of another commodity'
            : !onBill && lot.status === 'cancelled'
              ? 'The purchase of this lot is cancelled'
              : null;
      if (message) errors.push({ field: `items.${i}.purchaseItemId`, message });
    });
  }

  /** Shop defaults; a shop without a settings row has the column defaults. */
  private async shop({ tx, tenantId }: TenantScope): Promise<Shop> {
    const [row] = await tx
      .select({
        defaultCommissionPct: tenantSettings.defaultCommissionPct,
        marketFeePct: tenantSettings.marketFeePct,
        labourPerBag: tenantSettings.labourPerBag,
        maundKg: tenantSettings.maundKg,
        creditLimitAction: tenantSettings.creditLimitAction,
      })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId))
      .limit(1);
    return row
      ? {
          ...row,
          creditLimitAction: row.creditLimitAction as CreditLimitAction,
        }
      : { ...SHOP_CHARGE_DEFAULTS, maundKg: '40', creditLimitAction: 'warn' };
  }

  /** The sale, locked until the transaction ends (edit and cancel). */
  private async lock({ tx, scoped }: TenantScope, id: string) {
    const [row] = await tx
      .select()
      .from(sales)
      .where(scoped(sales).byId(id))
      .for('update');
    if (!row) throw notFound();
    return row;
  }

  private async linesOf({ tx, scoped }: TenantScope, saleId: string) {
    const [items, charges] = await Promise.all([
      tx
        .select()
        .from(saleItems)
        .where(scoped(saleItems).where(eq(saleItems.saleId, saleId)))
        .orderBy(asc(saleItems.createdAt), asc(saleItems.id)),
      tx
        .select()
        .from(saleCharges)
        .where(scoped(saleCharges).where(eq(saleCharges.saleId, saleId)))
        .orderBy(asc(saleCharges.createdAt), asc(saleCharges.id)),
    ]);
    return { items, charges };
  }

  private async findByKey(key: string): Promise<Sale | null> {
    return this.db.transaction(async (scope) => {
      const [row] = await scope.tx
        .select()
        .from(sales)
        .where(
          and(
            eq(sales.tenantId, scope.tenantId),
            isNull(sales.deletedAt),
            eq(sales.idempotencyKey, key),
          ),
        )
        .limit(1);
      return row ? this.detail(scope, row) : null;
    });
  }

  private async detail(scope: TenantScope, row: SaleRow): Promise<Sale> {
    const { tx, tenantId } = scope;
    const [[buyer], { items, charges }, names] = await Promise.all([
      // Deleted traders included: an old bill keeps its name.
      tx
        .select({ id: traders.id, name: traders.name })
        .from(traders)
        .where(
          and(eq(traders.tenantId, tenantId), eq(traders.id, row.buyerId)),
        ),
      this.linesOf(scope, row.id),
      tx
        .select({ id: commodities.id, name: commodities.name })
        .from(commodities)
        .innerJoin(
          saleItems,
          and(
            eq(saleItems.commodityId, commodities.id),
            eq(saleItems.saleId, row.id),
          ),
        )
        .where(eq(commodities.tenantId, tenantId)),
    ]);
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    return {
      ...toSummary(row, buyer),
      items: items.map((item) => toItem(item, nameOf.get(item.commodityId))),
      charges: charges.map(toCharge),
      createdBy: row.createdBy,
    };
  }
}

/** Drops keys that are `undefined` (not sent), keeps `null` (reset). */
function definedOnly(charges: Record<string, string | null | undefined>) {
  return Object.fromEntries(
    Object.entries(charges).filter(([, v]) => v !== undefined),
  ) as ManualCharges;
}

function toLine(item: ItemRow): Line {
  return {
    commodityId: item.commodityId,
    purchaseItemId: item.purchaseItemId,
    bags: item.bags,
    weightKg: item.weightKg,
    rate: item.rate,
    rateUnit: item.rateUnit as RateUnit,
  };
}

export function toItem(
  item: ItemRow,
  commodityName = '',
): Sale['items'][number] {
  return {
    id: item.id,
    commodityId: item.commodityId,
    commodityName,
    purchaseItemId: item.purchaseItemId,
    bags: item.bags,
    weightKg: item.weightKg,
    rate: item.rate,
    rateUnit: item.rateUnit as RateUnit,
    amount: item.amount,
  };
}

export function toCharge(charge: ChargeRow): Sale['charges'][number] {
  return {
    id: charge.id,
    type: charge.type as Sale['charges'][number]['type'],
    basis: charge.basis as Sale['charges'][number]['basis'],
    value: charge.value,
    amount: charge.amount,
  };
}
