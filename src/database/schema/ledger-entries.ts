import {
  type AnyPgColumn,
  bigserial,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenantIsolation } from '../tenant-table';
import { tenants } from './tenants';
import { traders } from './traders';
import { users } from './users';

/**
 * A trader's khata. Append-only: entries are never updated or deleted; a
 * mistake is corrected with a `reversal` entry. Balances are summed, never stored.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    traderId: uuid('trader_id')
      .notNull()
      .references(() => traders.id),
    entryDate: date('entry_date').notNull(),
    // opening | purchase | sale | payment | receipt | adjustment | reversal
    sourceType: varchar('source_type', { length: 20 }).notNull(),
    // The purchase / sale / payment that created it.
    sourceId: uuid('source_id'),
    debit: numeric('debit', { precision: 14, scale: 2 }).notNull().default('0'),
    credit: numeric('credit', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    narration: text('narration'),
    createdBy: uuid('created_by').references((): AnyPgColumn => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('ledger_entries_tenant_id_trader_id_entry_date_idx').on(
      t.tenantId,
      t.traderId,
      t.entryDate,
    ),
    index('ledger_entries_tenant_id_source_type_source_id_idx').on(
      t.tenantId,
      t.sourceType,
      t.sourceId,
    ),
    tenantIsolation(),
  ],
);
