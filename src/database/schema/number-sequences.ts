import {
  integer,
  pgTable,
  primaryKey,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenantIsolation } from '../tenant-table';
import { tenants } from './tenants';

/**
 * One bill-number counter per shop, document type and financial year.
 * Rows are created on the first number of a year and locked while a number
 * is taken, so concurrent saves never share or skip a number.
 */
export const numberSequences = pgTable(
  'number_sequences',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // purchase | sale | payment | receipt
    docType: varchar('doc_type', { length: 20 }).notNull(),
    // e.g. 2026-27
    financialYear: varchar('financial_year', { length: 9 }).notNull(),
    prefix: varchar('prefix', { length: 10 }),
    nextNumber: integer('next_number').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.docType, t.financialYear] }),
    tenantIsolation(),
  ],
);
