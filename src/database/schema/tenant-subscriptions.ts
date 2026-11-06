import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenantIsolation } from '../tenant-table';
import { plans } from './plans';
import { tenants } from './tenants';

export const SUBSCRIPTION_STATUSES = [
  'active',
  'expired',
  'cancelled',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * A shop's plan for a period. The current one is the latest by `ends_on`
 * that is not cancelled; what the shop may do is worked out from its dates
 * on every request (see `access-state.ts`), `status` follows by the daily job.
 * Shops only read it (RLS); the super-admin and the daily job write it.
 */
export const tenantSubscriptions = pgTable(
  'tenant_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    // 'YYYY-MM-DD' in Asia/Karachi; both days included.
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    graceDays: integer('grace_days').notNull().default(7),
    // active | expired | cancelled
    status: varchar('status', { length: 20 })
      .$type<SubscriptionStatus>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('tenant_subscriptions_tenant_id_ends_on_idx').on(
      t.tenantId,
      t.endsOn,
    ),
    check(
      'tenant_subscriptions_status',
      sql`${t.status} in ('active', 'expired', 'cancelled')`,
    ),
    check('tenant_subscriptions_dates', sql`${t.endsOn} >= ${t.startsOn}`),
    check('tenant_subscriptions_grace_days', sql`${t.graceDays} >= 0`),
    tenantIsolation(),
  ],
);
