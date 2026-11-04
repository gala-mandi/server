import {
  boolean,
  numeric,
  pgTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenantColumns, tenantIsolation } from '../tenant-table';

/**
 * Items a shop trades (gandum, kapas, …) with their default unit and bag
 * weight. Empty charge columns mean "use the shop default" from
 * `tenant_settings`.
 */
export const commodities = pgTable(
  'commodities',
  {
    ...tenantColumns(),
    name: varchar('name', { length: 80 }).notNull(),
    nameUr: varchar('name_ur', { length: 80 }),
    category: varchar('category', { length: 40 }),
    // kg | maund | bag
    defaultUnit: varchar('default_unit', { length: 10 })
      .notNull()
      .default('maund'),
    bagWeightKg: numeric('bag_weight_kg', { precision: 8, scale: 3 }),
    // Override the shop default when set.
    commissionPct: numeric('commission_pct', { precision: 5, scale: 2 }),
    marketFeePct: numeric('market_fee_pct', { precision: 5, scale: 2 }),
    labourPerBag: numeric('labour_per_bag', { precision: 14, scale: 2 }),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [
    // One name per shop; soft-deleted rows keep their name (like traders' phone).
    uniqueIndex('commodities_tenant_id_name_key').on(t.tenantId, t.name),
    tenantIsolation(),
  ],
);
