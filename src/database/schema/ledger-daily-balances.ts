import { date, numeric, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { tenantIsolation } from '../tenant-table';
import { tenants } from './tenants';
import { traders } from './traders';

/**
 * Daily balance snapshots: each trader's debit and credit totals per day,
 * kept by a trigger on `ledger_entries` in the same transaction as the entry
 * (migration `0010_ledger_daily_balances`). Never written by the API. A
 * balance on any date is the sum of the days up to it, so statements and
 * balances read one row per day instead of every entry. The reconciliation
 * check compares it with the entries.
 */
export const ledgerDailyBalances = pgTable(
  'ledger_daily_balances',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    traderId: uuid('trader_id')
      .notNull()
      .references(() => traders.id),
    entryDate: date('entry_date').notNull(),
    debit: numeric('debit', { precision: 14, scale: 2 }).notNull().default('0'),
    credit: numeric('credit', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.traderId, t.entryDate] }),
    tenantIsolation(),
  ],
);
