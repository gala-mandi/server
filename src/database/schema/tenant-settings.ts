import {
  date,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenantIsolation } from '../tenant-table';
import { tenants } from './tenants';

/** One row per shop, created with the shop. */
export const tenantSettings = pgTable(
  'tenant_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    displayName: varchar('display_name', { length: 120 }),
    parchiFooter: text('parchi_footer'),
    defaultCommissionPct: numeric('default_commission_pct', {
      precision: 5,
      scale: 2,
    })
      .notNull()
      .default('0'),
    marketFeePct: numeric('market_fee_pct', { precision: 5, scale: 2 })
      .notNull()
      .default('0'),
    labourPerBag: numeric('labour_per_bag', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    // kg | maund | bag
    defaultUnit: varchar('default_unit', { length: 10 })
      .notNull()
      .default('kg'),
    maundKg: numeric('maund_kg', { precision: 6, scale: 3 })
      .notNull()
      .default('40'),
    billPrefix: varchar('bill_prefix', { length: 10 }),
    financialYearStart: date('financial_year_start'),
    // en | ur
    language: varchar('language', { length: 5 }).notNull().default('en'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  () => [tenantIsolation()],
);
