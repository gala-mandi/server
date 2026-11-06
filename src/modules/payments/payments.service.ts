import {
  BadRequestException,
  ConflictException,
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
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { FieldError } from '../../common/filters/all-exceptions.filter';
import { karachiDate } from '../../common/time/karachi-date';
import {
  paymentAllocations,
  payments,
  purchases,
  sales,
  tenantSettings,
  traders,
} from '../../database/schema';
import {
  TenantDatabase,
  type TenantScope,
} from '../../database/tenant-database';
import { InvalidEntryError } from '../ledger/ledger-math';
import { LedgerReconciliation } from '../ledger/ledger-reconciliation.service';
import { LedgerService } from '../ledger/ledger.service';
import { nextNumber } from '../numbering/next-number';
import { type Actor, isUniqueViolation } from '../purchases/purchases.service';
import { likePattern, traderSearch } from '../traders/trader-search';
import { allocationsOf, type BillKind } from './bill-allocations';
import { type CashBook, cashBook } from './cash-book';
import {
  allocate,
  type AllocationRequest,
  type BillState,
  type Direction,
  outstandingOf,
  owedOf,
  overpaymentOf,
} from './payment-allocation';
import { postPayment, reversePayment } from './payment-ledger';
import {
  OVERPAYMENT,
  type OverpaymentAction,
  overpaymentMessage,
  TRADER_TYPE,
  TRADER_TYPE_MESSAGE,
} from './payment-rules';
import {
  type AllocationInput,
  type CashBookQuery,
  type CreatePaymentInput,
  type ListPaymentsQuery,
  MAX_CASH_BOOK_DAYS,
  type Payment,
  type PaymentMethod,
  type PaymentStatus,
  type PaymentSummary,
  type PaymentWarning,
  type SavedPayment,
} from './payments.dto';

export type { Actor };

type PaymentRow = typeof payments.$inferSelect;

/** created_at of allocation rows: keeps their order within one save. */
const rowTime = sql`clock_timestamp()` as unknown as Date;

const IDEMPOTENCY_KEY_INDEX = 'payments_tenant_id_idempotency_key_key';

const notFound = () => new NotFoundException('Payment not found');

const invalid = (errors: FieldError[]) =>
  new BadRequestException({ message: 'Validation failed', errors });

const cancelled = () =>
  new ConflictException({
    message: 'This payment is cancelled',
    code: 'PAYMENT_CANCELLED',
  });

/** A payment date as a moment, for the financial year of its voucher number. */
const dayAt = (date: string) => new Date(`${date}T12:00:00+05:00`);

const BILL_KIND: Record<Direction, BillKind> = {
  paid: 'purchase',
  received: 'sale',
};

/** The voucher series of each direction (see `number_sequences.doc_type`). */
const DOC_TYPE = { paid: 'payment', received: 'receipt' } as const;

/** Rupees of this payment's own allocation rows (history of a cancelled one too). */
const ownAllocated = sql<string>`(select coalesce(sum(${paymentAllocations.amount}), 0)::numeric(14,2)::text
    from ${paymentAllocations}
   where ${paymentAllocations.tenantId} = ${payments.tenantId}
     and ${paymentAllocations.paymentId} = ${payments.id}
     and ${paymentAllocations.deletedAt} is null)`;

export function toSummary(
  row: PaymentRow,
  trader: { id: string; name: string },
  allocated: string,
): PaymentSummary {
  return {
    id: row.id,
    voucherNo: row.voucherNo,
    direction: row.direction as Direction,
    paymentDate: row.paymentDate,
    trader,
    amount: row.amount,
    allocated: new Decimal(allocated).toFixed(2),
    advance: new Decimal(row.amount).minus(allocated).toFixed(2),
    method: row.method as PaymentMethod,
    reference: row.reference,
    status: row.status,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Wrong bill kinds for the direction (a sale on a payment, a purchase on a
 * receipt) as field errors, and the rest as allocation requests.
 */
export function splitAllocations(
  direction: Direction,
  inputs: readonly AllocationInput[],
): { requests: (AllocationRequest | null)[]; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const requests = inputs.map((input, i) => {
    const billId = direction === 'paid' ? input.purchaseId : input.saleId;
    if (billId) return { billId, amount: input.amount };
    errors.push(
      direction === 'paid'
        ? {
            field: `allocations.${i}.saleId`,
            message: 'A payment settles purchase bills; choose a purchase',
          }
        : {
            field: `allocations.${i}.purchaseId`,
            message: 'A receipt settles sale bills; choose a sale',
          },
    );
    return null;
  });
  return { requests, errors };
}

/**
 * Payments to kissans and receipts from beoparis. A save writes the payment,
 * its allocations to bills, its voucher number and its khata line in one
 * transaction: all or nothing. A cancel reverses the khata line; the
 * allocations then no longer count.
 */
@Injectable()
export class PaymentsService implements OnModuleInit {
  constructor(
    private readonly db: TenantDatabase,
    private readonly ledger: LedgerService,
    private readonly reconciliation: LedgerReconciliation,
  ) {}

  onModuleInit(): void {
    // A payment must hold +amount in the kissan's khata (debit), a receipt
    // −amount in the beopari's (credit); a cancelled one 0.
    for (const [direction, sourceType, sign] of [
      ['paid', 'payment', sql`1`],
      ['received', 'receipt', sql`-1`],
    ] as const) {
      this.reconciliation.register({
        sourceType,
        expected: sql`
          select ${payments.tenantId} as tenant_id,
                 ${payments.traderId} as trader_id,
                 ${payments.id} as source_id,
                 case when ${payments.status} = 'posted'
                      then ${sign} * ${payments.amount}
                      else 0 end as net
            from ${payments}
           where ${payments.direction} = ${direction}`,
      });
    }
  }

  /**
   * Saves a new payment, or returns the one already saved with this
   * `Idempotency-Key` (double click, retry after a lost response).
   */
  async create(
    input: CreatePaymentInput,
    actor: Actor,
    idempotencyKey: string,
    now: Date = new Date(),
  ): Promise<{ payment: SavedPayment; replayed: boolean }> {
    const earlier = await this.findByKey(idempotencyKey);
    if (earlier) {
      return { payment: { ...earlier, warnings: [] }, replayed: true };
    }
    try {
      const payment = await this.db.transaction((scope) =>
        this.insert(scope, input, actor, idempotencyKey, now),
      );
      return { payment, replayed: false };
    } catch (error) {
      // The same key at the same moment: the other save won, this one rolled
      // back (and gave its voucher number back).
      if (isUniqueViolation(error, IDEMPOTENCY_KEY_INDEX)) {
        const winner = await this.findByKey(idempotencyKey);
        if (winner) {
          return { payment: { ...winner, warnings: [] }, replayed: true };
        }
      }
      throw error;
    }
  }

  async list(query: ListPaymentsQuery) {
    return this.db.transaction(async ({ tx, scoped }) => {
      const filters: SQL[] = [];
      if (query.from) filters.push(gte(payments.paymentDate, query.from));
      if (query.to) filters.push(lte(payments.paymentDate, query.to));
      if (query.direction) {
        filters.push(eq(payments.direction, query.direction));
      }
      if (query.trader) filters.push(eq(payments.traderId, query.trader));
      if (query.method) filters.push(eq(payments.method, query.method));
      if (query.status) filters.push(eq(payments.status, query.status));
      if (query.search) {
        filters.push(
          or(
            ilike(payments.voucherNo, likePattern(query.search)),
            traderSearch(query.search),
          )!,
        );
      }
      const where = scoped(payments).where(and(...filters));
      const order = {
        paymentDate: [asc(payments.paymentDate), asc(payments.createdAt)],
        '-paymentDate': [desc(payments.paymentDate), desc(payments.createdAt)],
        voucherNo: [asc(payments.voucherNo)],
        '-voucherNo': [desc(payments.voucherNo)],
      }[query.sort];
      // Traders are joined with deleted ones: an old voucher keeps its name.
      const join = and(
        eq(traders.id, payments.traderId),
        eq(traders.tenantId, payments.tenantId),
      );

      const rows = await tx
        .select({
          payment: payments,
          trader: { id: traders.id, name: traders.name },
          allocated: ownAllocated,
        })
        .from(payments)
        .innerJoin(traders, join)
        .where(where)
        .orderBy(...order, asc(payments.id))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit);
      const [{ total }] = await tx
        .select({ total: count() })
        .from(payments)
        .innerJoin(traders, join)
        .where(where);
      return {
        data: rows.map((r) => toSummary(r.payment, r.trader, r.allocated)),
        meta: { page: query.page, limit: query.limit, total },
      };
    });
  }

  get(id: string): Promise<Payment> {
    return this.db.transaction(async (scope) => {
      const row = await scope.scoped(payments).findById(id);
      if (!row) throw notFound();
      return this.detail(scope, row);
    });
  }

  /**
   * Cancels instead of deleting: the khata line is reversed (dated today),
   * the voucher keeps its number, and its allocations stop counting, so the
   * bills it settled are open again.
   */
  cancel(id: string, actor: Actor): Promise<Payment> {
    return this.db.transaction(async (scope) => {
      const before = await this.lock(scope, id);
      if (before.status === 'cancelled') throw cancelled();
      const after =
        (await scope
          .scoped(payments)
          .update(id, { status: 'cancelled' satisfies PaymentStatus })) ??
        before;
      await reversePayment(
        this.ledger,
        scope,
        { ...before, direction: before.direction as Direction },
        actor.id,
      );
      return this.detail(scope, after);
    });
  }

  /**
   * The cash book: cash received (from beoparis) and paid (to kissans) by
   * day, with the cash in hand. Only posted `cash` vouchers count; the
   * opening cash is every such voucher before `from`.
   */
  cashBook(query: CashBookQuery, now: Date = new Date()): Promise<CashBook> {
    const to = query.to ?? karachiDate(now);
    const from = query.from ?? to;
    if (from > to) {
      throw invalid([
        {
          field: 'from',
          message: 'The start date must be on or before the end date',
        },
      ]);
    }
    const span =
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000;
    if (span >= MAX_CASH_BOOK_DAYS) {
      throw invalid([
        { field: 'to', message: `Choose at most ${MAX_CASH_BOOK_DAYS} days` },
      ]);
    }
    return this.db.transaction((scope) => this.cashBookOf(scope, from, to));
  }

  /**
   * The cash book of a checked range inside an open transaction (the
   * reports reuse it). See `cashBook()`.
   */
  async cashBookOf(
    { tx, scoped }: TenantScope,
    from: string,
    to: string,
  ): Promise<CashBook> {
    const cash = scoped(payments).where(
      and(eq(payments.method, 'cash'), eq(payments.status, 'posted')),
    );
    const cashIn = sql<string>`coalesce(sum(${payments.amount}) filter (where ${payments.direction} = 'received'), 0)::numeric(14,2)::text`;
    const cashOut = sql<string>`coalesce(sum(${payments.amount}) filter (where ${payments.direction} = 'paid'), 0)::numeric(14,2)::text`;

    const [opening] = await tx
      .select({ cashIn, cashOut })
      .from(payments)
      .where(and(cash, lt(payments.paymentDate, from)));
    const days = await tx
      .select({ date: payments.paymentDate, cashIn, cashOut })
      .from(payments)
      .where(
        and(
          cash,
          gte(payments.paymentDate, from),
          lte(payments.paymentDate, to),
        ),
      )
      .groupBy(payments.paymentDate)
      .orderBy(asc(payments.paymentDate));
    const openingCash = new Decimal(opening.cashIn)
      .minus(opening.cashOut)
      .toFixed(2);
    return cashBook(from, to, openingCash, days);
  }

  /* ---------------------------------------------------------------- */

  private async insert(
    scope: TenantScope,
    input: CreatePaymentInput,
    actor: Actor,
    idempotencyKey: string,
    now: Date,
  ): Promise<SavedPayment> {
    const today = karachiDate(now);
    const date = input.paymentDate ?? today;
    if (date > today) {
      throw invalid([
        {
          field: 'paymentDate',
          message: 'A payment cannot be dated in the future',
        },
      ]);
    }
    const { direction } = input;

    // Locked so two payments to the same trader check the khata in turn.
    const trader = await this.lockTrader(scope, input.traderId);
    const errors: FieldError[] = [];
    const traderError = !trader
      ? 'Trader not found'
      : trader.type !== TRADER_TYPE[direction]
        ? TRADER_TYPE_MESSAGE[direction]
        : !trader.isActive
          ? 'This trader is inactive'
          : null;
    if (traderError) errors.push({ field: 'traderId', message: traderError });

    const split = splitAllocations(direction, input.allocations);
    errors.push(...split.errors);
    const requests = split.requests.map(
      (r) => r ?? { billId: '', amount: null },
    );
    const bills = await this.lockBills(
      scope,
      direction,
      requests.flatMap((r) => (r.billId ? [r.billId] : [])),
    );
    const result = allocate(
      direction,
      input.traderId,
      input.amount,
      requests,
      bills,
    );
    // Lines already refused for their kind need no second error.
    const refused = new Set(split.requests.flatMap((r, i) => (r ? [] : [i])));
    errors.push(
      ...result.errors.filter(
        (e) => !refused.has(Number(e.field.split('.')[1])),
      ),
    );
    if (errors.length || !trader) throw invalid(errors);

    const warnings = await this.checkOverpayment(
      scope,
      direction,
      trader,
      input.amount,
    );

    // Last before the inserts: a failed save rolls the number back too.
    const voucher = await nextNumber(scope, DOC_TYPE[direction], dayAt(date));
    // The scoped helper overwrites tenant_id; it never comes from the body.
    const values: typeof payments.$inferInsert = {
      tenantId: scope.tenantId,
      voucherNo: voucher.billNo,
      direction,
      traderId: input.traderId,
      paymentDate: date,
      amount: new Decimal(input.amount).toFixed(2),
      method: input.method,
      reference: input.reference,
      notes: input.notes,
      status: 'posted',
      idempotencyKey,
      createdBy: actor.id,
    };
    const [row] = await scope.scoped(payments).insert(values);
    // One row at a time with clock_timestamp(): created_at keeps their order.
    for (const allocation of result.allocations) {
      const values: typeof paymentAllocations.$inferInsert = {
        tenantId: scope.tenantId,
        paymentId: row.id,
        purchaseId: direction === 'paid' ? allocation.billId : null,
        saleId: direction === 'received' ? allocation.billId : null,
        amount: allocation.amount,
        createdBy: actor.id,
        createdAt: rowTime,
      };
      await scope.scoped(paymentAllocations).insert(values);
    }
    try {
      await postPayment(
        this.ledger,
        scope,
        { ...row, direction: row.direction as Direction },
        actor.id,
      );
    } catch (error) {
      if (error instanceof InvalidEntryError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    return { ...(await this.detail(scope, row)), warnings };
  }

  /**
   * "Pay more than the balance": a payment above what the khata owes is
   * saved with a warning (the rest is an advance), or refused with 409
   * `OVERPAYMENT` when the shop's `overpayment_action` is `block`.
   */
  private async checkOverpayment(
    scope: TenantScope,
    direction: Direction,
    trader: { id: string; name: string },
    amount: string,
  ): Promise<PaymentWarning[]> {
    const balance = await this.ledger.balance(scope, trader.id);
    const excess = overpaymentOf(direction, amount, balance);
    if (!excess) return [];
    const owed = owedOf(direction, balance).toFixed(2);
    const message = overpaymentMessage(direction, trader.name, owed, excess);
    if ((await this.overpaymentAction(scope)) === 'block') {
      throw new ConflictException({
        message,
        code: OVERPAYMENT,
        errors: [{ field: 'amount', message }],
      });
    }
    return [{ code: OVERPAYMENT, message, owed, excess }];
  }

  private async overpaymentAction({
    tx,
    tenantId,
  }: TenantScope): Promise<OverpaymentAction> {
    const [row] = await tx
      .select({ action: tenantSettings.overpaymentAction })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId))
      .limit(1);
    return (row?.action as OverpaymentAction | undefined) ?? 'advance';
  }

  /** The trader (not deleted), locked against other payments until commit. */
  private async lockTrader({ tx, scoped }: TenantScope, id: string) {
    const [row] = await tx
      .select({
        id: traders.id,
        name: traders.name,
        type: traders.type,
        isActive: traders.isActive,
      })
      .from(traders)
      .where(scoped(traders).byId(id))
      // Doesn't block khata lines (their foreign key takes a key-share lock).
      .for('no key update');
    return row ?? null;
  }

  /**
   * The bills a payment names, locked (in id order) so two payments, or a
   * payment and a bill edit or cancel, take turns; then what is left on
   * each, read in a new statement that sees what the others committed.
   */
  private async lockBills(
    scope: TenantScope,
    direction: Direction,
    ids: string[],
  ): Promise<Map<string, BillState>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const { tx, scoped } = scope;
    const rows =
      direction === 'paid'
        ? await tx
            .select({
              id: purchases.id,
              billNo: purchases.billNo,
              traderId: purchases.traderId,
              status: purchases.status,
              netAmount: purchases.netAmount,
              settledOnSave: purchases.paidAmount,
            })
            .from(purchases)
            .where(scoped(purchases).where(inArray(purchases.id, unique)))
            .orderBy(asc(purchases.id))
            .for('update')
        : await tx
            .select({
              id: sales.id,
              billNo: sales.billNo,
              traderId: sales.buyerId,
              status: sales.status,
              netAmount: sales.netAmount,
              settledOnSave: sales.receivedAmount,
            })
            .from(sales)
            .where(scoped(sales).where(inArray(sales.id, unique)))
            .orderBy(asc(sales.id))
            .for('update');
    const allocated = await allocationsOf(
      scope,
      BILL_KIND[direction],
      rows.map((r) => r.id),
    );
    return new Map(
      rows.map((r) => [
        r.id,
        {
          billNo: r.billNo,
          traderId: r.traderId,
          status: r.status,
          remaining: outstandingOf({
            ...r,
            allocated: allocated.get(r.id)?.total ?? '0',
          }),
        },
      ]),
    );
  }

  /** The payment, locked until the transaction ends (cancel). */
  private async lock({ tx, scoped }: TenantScope, id: string) {
    const [row] = await tx
      .select()
      .from(payments)
      .where(scoped(payments).byId(id))
      .for('update');
    if (!row) throw notFound();
    return row;
  }

  private async findByKey(key: string): Promise<Payment | null> {
    return this.db.transaction(async (scope) => {
      const [row] = await scope.tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, scope.tenantId),
            isNull(payments.deletedAt),
            eq(payments.idempotencyKey, key),
          ),
        )
        .limit(1);
      return row ? this.detail(scope, row) : null;
    });
  }

  private async detail(
    { tx, tenantId }: TenantScope,
    row: PaymentRow,
  ): Promise<Payment> {
    // Deleted traders included: an old voucher keeps its name.
    const [trader] = await tx
      .select({ id: traders.id, name: traders.name })
      .from(traders)
      .where(and(eq(traders.tenantId, tenantId), eq(traders.id, row.traderId)));
    const allocations = await tx
      .select({
        id: paymentAllocations.id,
        purchaseId: paymentAllocations.purchaseId,
        saleId: paymentAllocations.saleId,
        amount: paymentAllocations.amount,
        billNo: sql<string>`coalesce(${purchases.billNo}, ${sales.billNo})`,
        billDate: sql<string>`coalesce(${purchases.purchaseDate}, ${sales.saleDate})::text`,
      })
      .from(paymentAllocations)
      .leftJoin(
        purchases,
        and(
          eq(purchases.id, paymentAllocations.purchaseId),
          eq(purchases.tenantId, paymentAllocations.tenantId),
        ),
      )
      .leftJoin(
        sales,
        and(
          eq(sales.id, paymentAllocations.saleId),
          eq(sales.tenantId, paymentAllocations.tenantId),
        ),
      )
      .where(
        and(
          eq(paymentAllocations.tenantId, tenantId),
          eq(paymentAllocations.paymentId, row.id),
          isNull(paymentAllocations.deletedAt),
        ),
      )
      .orderBy(asc(paymentAllocations.createdAt), asc(paymentAllocations.id));
    const allocated = allocations
      .reduce((sum, a) => sum.plus(a.amount), new Decimal(0))
      .toFixed(2);
    return {
      ...toSummary(row, trader, allocated),
      allocations,
      createdBy: row.createdBy,
    };
  }
}
