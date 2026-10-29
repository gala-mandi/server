import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenantColumns, tenantIsolation } from '../tenant-table';

export const traderType = pgEnum('trader_type', ['kissan', 'beopari', 'arhti']);

/** Farmers (kissan), buyers (beopari) and other commission agents (arhti) of one shop. */
export const traders = pgTable(
  'traders',
  {
    ...tenantColumns(),
    type: traderType('type').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    fatherName: varchar('father_name', { length: 120 }),
    phone: varchar('phone', { length: 20 }),
    cnic: varchar('cnic', { length: 15 }),
    village: varchar('village', { length: 80 }),
    address: text('address'),
    openingBalance: numeric('opening_balance', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    // debit | credit
    openingBalanceType: varchar('opening_balance_type', { length: 6 })
      .notNull()
      .default('debit'),
    creditLimit: numeric('credit_limit', { precision: 14, scale: 2 }),
    isActive: boolean('is_active').notNull().default(true),
    notes: text('notes'),
  },
  (t) => [
    // One phone per shop; NULL phones don't collide.
    uniqueIndex('traders_tenant_id_phone_key').on(t.tenantId, t.phone),
    index('traders_tenant_id_type_idx').on(t.tenantId, t.type),
    // ILIKE '%ali%' on names (pg_trgm, enabled in the migration).
    index('traders_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
    tenantIsolation(),
  ],
);
