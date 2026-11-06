import {
  boolean,
  integer,
  numeric,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * A plan a shop can be on (Trial, Basic, Pro…) with its limits and price.
 * Platform table: no tenant_id, no RLS; only the super-admin writes it
 * (through `PlatformDatabase`), shops can only read it.
 */
export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 60 }).notNull().unique(),
  maxUsers: integer('max_users').notNull(),
  // Stored and shown; not enforced yet (there are no branches in the app).
  maxBranches: integer('max_branches').notNull().default(1),
  priceMonthly: numeric('price_monthly', { precision: 14, scale: 2 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
