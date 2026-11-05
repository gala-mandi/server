import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  type SQL,
  sql,
} from 'drizzle-orm';
import {
  ledgerDailyBalances,
  ledgerEntries,
  traders,
} from '../../database/schema';
import {
  TenantDatabase,
  type TenantScope,
} from '../../database/tenant-database';
import { shopDate } from '../numbering/bill-number';
import { traderSearch } from '../traders/trader-search';
import type {
  AdjustmentInput,
  Balances,
  BalancesQuery,
  LedgerEntry,
  SourceType,
  Statement,
  StatementQuery,
} from './ledger.dto';
import {
  type Amounts,
  addBalances,
  balanceOf,
  entryAmounts,
  receivablePayable,
  reversalOf,
  withRunningBalance,
} from './ledger-math';

type EntryRow = typeof ledgerEntries.$inferSelect;

/** A new khata line, as purchases, sales and payments post it. */
export interface NewEntry {
  traderId: string;
  /** `reversal` entries come only from `reverse()`. */
  sourceType: Exclude<SourceType, 'reversal'>;
  /** The document behind the entry (purchase, sale, payment id). */
  sourceId?: string | null;
  /** Rupee strings; exactly one side above 0. */
  debit?: string;
  credit?: string;
  narration?: string | null;
  /** YYYY-MM-DD; defaults to today in shop time. */
  entryDate?: string;
  userId: string | null;
}

/** Undo everything still open on one document. */
export interface Reversal {
  sourceType: Exclude<SourceType, 'reversal'>;
  sourceId: string;
  narration: string;
  /** YYYY-MM-DD; defaults to today in shop time (the day it is cancelled). */
  entryDate?: string;
  userId: string | null;
}

export function toEntry(row: EntryRow): LedgerEntry {
  return {
    id: row.id,
    traderId: row.traderId,
    entryDate: row.entryDate,
    sourceType: row.sourceType as SourceType,
    sourceId: row.sourceId,
    debit: row.debit,
    credit: row.credit,
    narration: row.narration,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

const ZERO: Amounts = { debit: '0', credit: '0' };
const today = sql`(now() at time zone 'Asia/Karachi')::date`;
const traderNotFound = () => new NotFoundException('Trader not found');

/**
 * The khata. The only code that writes `ledger_entries`: purchases, sales and
 * payments call `post()` and `reverse()` inside their own transaction, never
 * a controller. Entries are never updated or deleted; balances are summed from
 * them (through the daily snapshots the database keeps beside them).
 */
@Injectable()
export class LedgerService {
  constructor(private readonly db: TenantDatabase) {}

  /**
   * Adds one entry for a trader of the scope's shop. Call it inside the
   * document's transaction so both are saved or neither.
   *
   * @throws NotFoundException when the trader is not in this shop
   * @throws InvalidEntryError when the amounts are not one positive side
   */
  async post(scope: TenantScope, entry: NewEntry): Promise<LedgerEntry> {
    const amounts = entryAmounts(entry.debit, entry.credit);
    const trader = await scope.scoped(traders).findById(entry.traderId);
    if (!trader) throw traderNotFound();
    return toEntry(await this.insert(scope, { ...entry, ...amounts }));
  }

  /**
   * Reverses what is left of a document in the khata (its entries and any
   * earlier reversals), per trader, so its net becomes 0. Calling it again
   * adds nothing. Use it when a purchase, sale or payment is cancelled.
   */
  async reverse(
    scope: TenantScope,
    reversal: Reversal,
  ): Promise<LedgerEntry[]> {
    const { tx, tenantId } = scope;
    // Two cancels of the same document at once would both see it open.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${reversal.sourceId}, 0))`,
    );
    const open = await tx
      .select({
        traderId: ledgerEntries.traderId,
        debit: sql<string>`sum(${ledgerEntries.debit})::text`,
        credit: sql<string>`sum(${ledgerEntries.credit})::text`,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.tenantId, tenantId),
          eq(ledgerEntries.sourceId, reversal.sourceId),
          inArray(ledgerEntries.sourceType, [reversal.sourceType, 'reversal']),
        ),
      )
      .groupBy(ledgerEntries.traderId)
      .orderBy(asc(ledgerEntries.traderId));

    const added: LedgerEntry[] = [];
    for (const { traderId, ...totals } of open) {
      const amounts = reversalOf(balanceOf(totals));
      if (!amounts) continue;
      const row = await this.insert(scope, {
        traderId,
        sourceType: 'reversal',
        sourceId: reversal.sourceId,
        narration: reversal.narration,
        entryDate: reversal.entryDate,
        userId: reversal.userId,
        ...amounts,
      });
      added.push(toEntry(row));
    }
    return added;
  }

  /** A trader's balance (debit minus credit) at the end of `asOf`, or now. */
  async balance(
    { tx, tenantId }: Pick<TenantScope, 'tx' | 'tenantId'>,
    traderId: string,
    asOf?: string,
  ): Promise<string> {
    const totals = await this.dailyTotals(
      tx,
      and(
        eq(ledgerDailyBalances.tenantId, tenantId),
        eq(ledgerDailyBalances.traderId, traderId),
        asOf ? lte(ledgerDailyBalances.entryDate, asOf) : undefined,
      ),
    );
    return balanceOf(totals);
  }

  /** `GET /ledger/:traderId`: one trader's entries with running balance. */
  statement(traderId: string, query: StatementQuery): Promise<Statement> {
    return this.db.transaction(async ({ tx, tenantId, scoped }) => {
      const trader = await scoped(traders).findById(traderId);
      if (!trader) throw traderNotFound();

      const day = ledgerDailyBalances;
      const ofTrader = and(
        eq(day.tenantId, tenantId),
        eq(day.traderId, traderId),
      );
      const inRange = and(
        eq(ledgerEntries.tenantId, tenantId),
        eq(ledgerEntries.traderId, traderId),
        query.from ? gte(ledgerEntries.entryDate, query.from) : undefined,
        query.to ? lte(ledgerEntries.entryDate, query.to) : undefined,
      );
      const offset = (query.page - 1) * query.limit;
      const khataOrder = [asc(ledgerEntries.entryDate), asc(ledgerEntries.id)];

      const [before, range, [{ total }], earlierOnPage, rows] =
        await Promise.all([
          query.from
            ? this.dailyTotals(tx, and(ofTrader, lt(day.entryDate, query.from)))
            : ZERO,
          this.dailyTotals(
            tx,
            and(
              ofTrader,
              query.from ? gte(day.entryDate, query.from) : undefined,
              query.to ? lte(day.entryDate, query.to) : undefined,
            ),
          ),
          tx.select({ total: count() }).from(ledgerEntries).where(inRange),
          // Entries of the range on earlier pages carry into this page.
          offset > 0 ? this.firstEntriesTotals(tx, inRange, offset) : ZERO,
          tx
            .select()
            .from(ledgerEntries)
            .where(inRange)
            .orderBy(...khataOrder)
            .limit(query.limit)
            .offset(offset),
        ]);

      const openingBalance = balanceOf(before);
      return {
        trader: { id: trader.id, type: trader.type, name: trader.name },
        from: query.from ?? null,
        to: query.to ?? null,
        openingBalance,
        closingBalance: addBalances(openingBalance, balanceOf(range)),
        data: withRunningBalance(
          addBalances(openingBalance, balanceOf(earlierOnPage)),
          rows.map(toEntry),
        ),
        meta: { page: query.page, limit: query.limit, total },
      };
    });
  }

  /** `GET /ledger/balances`: every trader's receivable or payable. */
  balances(query: BalancesQuery): Promise<Balances> {
    return this.db.transaction(async ({ tx, tenantId, scoped }) => {
      const day = ledgerDailyBalances;
      const sums = tx
        .select({
          traderId: day.traderId,
          balance: sql<string>`sum(${day.debit}) - sum(${day.credit})`.as(
            'balance',
          ),
        })
        .from(day)
        .where(eq(day.tenantId, tenantId))
        .groupBy(day.traderId)
        .as('sums');
      const balance = sql`coalesce(${sums.balance}, 0)`;

      const filters: SQL[] = [];
      if (query.type) filters.push(eq(traders.type, query.type));
      if (query.search) filters.push(traderSearch(query.search));
      const where = scoped(traders).where(and(...filters));

      const order = {
        name: [asc(traders.name)],
        '-name': [desc(traders.name)],
        balance: [asc(balance), asc(traders.name)],
        '-balance': [desc(balance), asc(traders.name)],
      }[query.sort];

      const [rows, [summary]] = await Promise.all([
        tx
          .select({
            traderId: traders.id,
            type: traders.type,
            name: traders.name,
            phone: traders.phone,
            balance: sql<string>`${balance}::numeric(14,2)::text`,
          })
          .from(traders)
          .leftJoin(sums, eq(sums.traderId, traders.id))
          .where(where)
          .orderBy(...order, asc(traders.id))
          .limit(query.limit)
          .offset((query.page - 1) * query.limit),
        tx
          .select({
            total: count(),
            receivable: sql<string>`coalesce(sum(greatest(${balance}, 0)), 0)::numeric(14,2)::text`,
            payable: sql<string>`coalesce(sum(greatest(-${balance}, 0)), 0)::numeric(14,2)::text`,
          })
          .from(traders)
          .leftJoin(sums, eq(sums.traderId, traders.id))
          .where(where),
      ]);

      return {
        data: rows.map((row) => ({
          ...row,
          ...receivablePayable(row.balance),
        })),
        totals: { receivable: summary.receivable, payable: summary.payable },
        meta: { page: query.page, limit: query.limit, total: summary.total },
      };
    });
  }

  /** `POST /ledger/adjustments`: the owner's manual correction, with reason. */
  adjust(input: AdjustmentInput, userId: string): Promise<LedgerEntry> {
    if (input.entryDate && input.entryDate > shopDate(new Date())) {
      throw new BadRequestException({
        message: 'An adjustment cannot be dated in the future',
        errors: [
          {
            field: 'entryDate',
            message: 'An adjustment cannot be dated in the future',
          },
        ],
      });
    }
    return this.db.transaction((scope) =>
      this.post(scope, {
        traderId: input.traderId,
        sourceType: 'adjustment',
        sourceId: null,
        debit: input.side === 'debit' ? input.amount : '0',
        credit: input.side === 'credit' ? input.amount : '0',
        narration: input.reason,
        entryDate: input.entryDate,
        userId,
      }),
    );
  }

  private async insert(
    { tx, tenantId, audit }: TenantScope,
    entry: Omit<NewEntry, 'sourceType'> & {
      sourceType: SourceType;
    } & Amounts,
  ): Promise<EntryRow> {
    const [row] = await tx
      .insert(ledgerEntries)
      .values({
        tenantId,
        traderId: entry.traderId,
        entryDate: entry.entryDate ?? today,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId ?? null,
        debit: entry.debit,
        credit: entry.credit,
        narration: entry.narration ?? null,
        createdBy: entry.userId,
      })
      .returning();
    // audit_logs.entity_id is a uuid and ledger ids are bigserial: log the
    // entry under its trader (the row, with its id, is in `after`).
    await audit({
      entity: 'ledger_entries',
      entityId: entry.traderId,
      action: 'create',
      after: row,
    });
    return row;
  }

  private async dailyTotals(
    tx: TenantScope['tx'],
    where: SQL | undefined,
  ): Promise<Amounts> {
    const [row] = await tx
      .select({
        debit: sql<string>`coalesce(sum(${ledgerDailyBalances.debit}), 0)::text`,
        credit: sql<string>`coalesce(sum(${ledgerDailyBalances.credit}), 0)::text`,
      })
      .from(ledgerDailyBalances)
      .where(where);
    return row ?? ZERO;
  }

  /** Totals of the first `n` entries matching `where`, in khata order. */
  private async firstEntriesTotals(
    tx: TenantScope['tx'],
    where: SQL | undefined,
    n: number,
  ): Promise<Amounts> {
    const first = tx
      .select({ debit: ledgerEntries.debit, credit: ledgerEntries.credit })
      .from(ledgerEntries)
      .where(where)
      .orderBy(asc(ledgerEntries.entryDate), asc(ledgerEntries.id))
      .limit(n)
      .as('first');
    const [row] = await tx
      .select({
        debit: sql<string>`coalesce(sum(${first.debit}), 0)::text`,
        credit: sql<string>`coalesce(sum(${first.credit}), 0)::text`,
      })
      .from(first);
    return row ?? ZERO;
  }
}
