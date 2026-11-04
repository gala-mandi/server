import {
  ConflictException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  not,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { ledgerEntries, traders } from '../../database/schema';
import {
  TenantDatabase,
  type TenantScope,
} from '../../database/tenant-database';
import { RestorableRegistry } from '../audit/restorable-registry';
import { isPhoneUniqueViolation } from '../staff/phone-account';
import type {
  CreateTraderInput,
  ListTradersQuery,
  LookupTradersQuery,
  Trader,
  TraderDetail,
  TraderLookupItem,
  UpdateTraderInput,
} from './traders.dto';

type TraderRow = typeof traders.$inferSelect;
type BalanceType = 'debit' | 'credit';

export function toTrader(row: TraderRow): Trader {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    fatherName: row.fatherName,
    phone: row.phone,
    cnic: row.cnic,
    village: row.village,
    address: row.address,
    openingBalance: row.openingBalance,
    openingBalanceType: row.openingBalanceType as BalanceType,
    creditLimit: row.creditLimit,
    isActive: row.isActive,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `%`, `_` and `\` typed by the user match themselves, not any text. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** True when the amount string is more than zero ("0", "0.00" are not). */
const isPositive = (amount: string) => /[1-9]/.test(amount);

const phoneTaken = () =>
  new ConflictException({
    message: 'Another trader in this shop has this phone number',
    code: 'PHONE_TAKEN',
    errors: [
      {
        field: 'phone',
        message: 'Another trader in this shop has this phone number',
      },
    ],
  });

const notFound = () => new NotFoundException('Trader not found');

/** A shop's traders. Every write is audited; the khata is append-only. */
@Injectable()
export class TradersService implements OnModuleInit {
  constructor(
    private readonly db: TenantDatabase,
    private readonly restorable: RestorableRegistry,
  ) {}

  onModuleInit(): void {
    this.restorable.register('traders', traders);
  }

  async list(query: ListTradersQuery) {
    return this.db.transaction(async ({ tx, scoped }) => {
      const filters: SQL[] = [];
      if (query.type) filters.push(eq(traders.type, query.type));
      if (query.active !== undefined) {
        filters.push(eq(traders.isActive, query.active));
      }
      if (query.search) filters.push(this.searchFilter(query.search));
      const where = scoped(traders).where(and(...filters));

      const order = {
        name: asc(traders.name),
        '-name': desc(traders.name),
        createdAt: asc(traders.createdAt),
        '-createdAt': desc(traders.createdAt),
      }[query.sort];

      const [rows, [{ total }]] = await Promise.all([
        tx
          .select()
          .from(traders)
          .where(where)
          .orderBy(order, asc(traders.id))
          .limit(query.limit)
          .offset((query.page - 1) * query.limit),
        tx.select({ total: count() }).from(traders).where(where),
      ]);
      return {
        data: rows.map(toTrader),
        meta: { page: query.page, limit: query.limit, total },
      };
    });
  }

  /** Active traders for pickers in purchase and sale forms. */
  lookup(query: LookupTradersQuery): Promise<TraderLookupItem[]> {
    return this.db.transaction(async ({ tx, scoped }) => {
      const filters: SQL[] = [eq(traders.isActive, true)];
      if (query.type) filters.push(eq(traders.type, query.type));
      if (query.q) filters.push(this.searchFilter(query.q));
      // Names starting with q first. Without q there is nothing to rank
      // (a constant would be `order by 0`, which Postgres rejects).
      const startsWith = query.q
        ? [
            sql`case when ${traders.name} ilike ${likePattern(query.q).slice(1)} then 0 else 1 end`,
          ]
        : [];
      return tx
        .select({
          id: traders.id,
          type: traders.type,
          name: traders.name,
          fatherName: traders.fatherName,
          phone: traders.phone,
          village: traders.village,
        })
        .from(traders)
        .where(scoped(traders).where(and(...filters)))
        .orderBy(...startsWith, asc(traders.name), asc(traders.id))
        .limit(query.limit);
    });
  }

  get(id: string): Promise<TraderDetail> {
    return this.db.transaction(async (scope) => {
      const row = await scope.scoped(traders).findById(id);
      if (!row) throw notFound();
      return { ...toTrader(row), balance: await this.balance(scope, id) };
    });
  }

  async create(input: CreateTraderInput, userId: string): Promise<Trader> {
    try {
      return await this.db.transaction(async (scope) => {
        const values: typeof traders.$inferInsert = {
          ...input,
          tenantId: scope.tenantId,
          createdBy: userId,
        };
        const [row] = await scope.scoped(traders).insert(values);
        await this.openingEntry(scope, row, userId);
        return toTrader(row);
      });
    } catch (error) {
      if (isPhoneUniqueViolation(error)) throw phoneTaken();
      throw error;
    }
  }

  async update(
    id: string,
    input: UpdateTraderInput,
    userId: string,
  ): Promise<TraderDetail> {
    try {
      return await this.db.transaction(async (scope) => {
        const before = await scope.scoped(traders).findById(id);
        if (!before) throw notFound();
        const row = Object.keys(input).length
          ? await scope.scoped(traders).update(id, input)
          : before;
        if (!row) throw notFound();

        // Both come from numeric(14,2), e.g. "500.00", so strings compare exactly.
        const openingChanged =
          row.openingBalance !== before.openingBalance ||
          (isPositive(row.openingBalance) &&
            row.openingBalanceType !== before.openingBalanceType);
        if (openingChanged) {
          // The khata is append-only: reverse the old opening, add the new one.
          await this.reverseOpening(scope, before, userId);
          await this.openingEntry(scope, row, userId);
        }
        return { ...toTrader(row), balance: await this.balance(scope, id) };
      });
    } catch (error) {
      if (isPhoneUniqueViolation(error)) throw phoneTaken();
      throw error;
    }
  }

  /** Soft delete; refused once the trader has real transactions. */
  remove(id: string): Promise<void> {
    return this.db.transaction(async (scope) => {
      const row = await scope.scoped(traders).findById(id);
      if (!row) throw notFound();
      if (await this.hasTransactions(scope, id)) {
        throw new ConflictException({
          message:
            'This trader has transactions and cannot be deleted. Deactivate the trader instead.',
          code: 'TRADER_HAS_TRANSACTIONS',
        });
      }
      await scope.scoped(traders).softDelete(id);
    });
  }

  private searchFilter(text: string): SQL {
    const name = ilike(traders.name, likePattern(text));
    const digits = text.replace(/\D/g, '');
    // Phones are stored as digits; "0300-123" finds 0300123….
    return digits.length >= 3
      ? or(name, ilike(traders.phone, likePattern(digits)))!
      : name;
  }

  private async balance({ tx }: TenantScope, traderId: string) {
    const [row] = await tx
      .select({
        balance: sql<string>`coalesce(sum(${ledgerEntries.debit}) - sum(${ledgerEntries.credit}), 0)::numeric(14,2)::text`,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.traderId, traderId));
    return row?.balance ?? '0.00';
  }

  /** Opening and its corrections are not transactions; anything else is. */
  private async hasTransactions({ tx }: TenantScope, traderId: string) {
    const [row] = await tx
      .select({ total: count() })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.traderId, traderId),
          not(
            and(
              eq(ledgerEntries.sourceId, traderId),
              inArray(ledgerEntries.sourceType, ['opening', 'reversal']),
            )!,
          ),
        ),
      );
    return (row?.total ?? 0) > 0;
  }

  private async openingEntry(
    scope: TenantScope,
    trader: TraderRow,
    userId: string,
  ) {
    if (!isPositive(trader.openingBalance)) return;
    const debit = trader.openingBalanceType === 'debit';
    await this.addEntry(scope, {
      traderId: trader.id,
      sourceType: 'opening',
      debit: debit ? trader.openingBalance : '0',
      credit: debit ? '0' : trader.openingBalance,
      narration: 'Opening balance',
      userId,
    });
  }

  private async reverseOpening(
    scope: TenantScope,
    before: TraderRow,
    userId: string,
  ) {
    if (!isPositive(before.openingBalance)) return;
    const debit = before.openingBalanceType === 'debit';
    await this.addEntry(scope, {
      traderId: before.id,
      sourceType: 'reversal',
      debit: debit ? '0' : before.openingBalance,
      credit: debit ? before.openingBalance : '0',
      narration: 'Opening balance corrected',
      userId,
    });
  }

  private async addEntry(
    { tx, tenantId, audit }: TenantScope,
    entry: {
      traderId: string;
      sourceType: 'opening' | 'reversal';
      debit: string;
      credit: string;
      narration: string;
      userId: string;
    },
  ) {
    const [row] = await tx
      .insert(ledgerEntries)
      .values({
        tenantId,
        traderId: entry.traderId,
        entryDate: sql`(now() at time zone 'Asia/Karachi')::date`,
        sourceType: entry.sourceType,
        sourceId: entry.traderId,
        debit: entry.debit,
        credit: entry.credit,
        narration: entry.narration,
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
  }
}
