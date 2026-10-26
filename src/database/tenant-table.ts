import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  pgPolicy,
  pgRole,
  type PgTable,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './schema/tenants';
import { users } from './schema/users';

/**
 * Database role every shop query runs as (`SET LOCAL ROLE app_tenant`).
 * Created by migration `0003_tenant_rls`; RLS policies apply to it.
 */
export const appTenantRole = pgRole('app_tenant').existing();

/**
 * Base columns of every business table:
 * `id`, `tenant_id` (NOT NULL), `created_by`, `created_at`, `updated_at`, `deleted_at`.
 *
 * @example
 * export const traders = pgTable(
 *   'traders',
 *   { ...tenantColumns(), name: varchar('name', { length: 120 }).notNull() },
 *   (t) => [index('traders_tenant_id_created_at_idx').on(t.tenantId, t.createdAt), tenantIsolation()],
 * );
 */
export function tenantColumns() {
  return {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    createdBy: uuid('created_by').references((): AnyPgColumn => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  };
}

/**
 * SQL both sides of the policy use: the row belongs to the request's shop.
 * `nullif` because a pooled connection that once had the setting reads it as
 * '' afterwards; NULL then matches no rows instead of failing the uuid cast.
 */
export const TENANT_MATCH = sql`tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * Row-Level Security policy for a business table. Adding it to the table's
 * extras makes drizzle-kit enable RLS and create the policy in the migration.
 * Without `app.tenant_id` set, the role sees no rows at all.
 */
export function tenantIsolation() {
  return pgPolicy('tenant_isolation', {
    as: 'permissive',
    for: 'all',
    to: appTenantRole,
    using: TENANT_MATCH,
    withCheck: TENANT_MATCH,
  });
}

/** A table built with `tenantColumns()`. */
export type TenantTable = PgTable & {
  id: AnyPgColumn;
  tenantId: AnyPgColumn;
  deletedAt: AnyPgColumn;
};
