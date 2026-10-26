import { index, pgTable, unique, varchar } from 'drizzle-orm/pg-core';
import {
  tenantColumns,
  tenantIsolation,
} from '../../src/database/tenant-table';

/**
 * Test-only business table. No real business tables exist yet, so the
 * isolation suites prove `tenantColumns()`, `tenantIsolation()`,
 * `tenantScoped()` and `TenantDatabase` on this one. It is created from this
 * definition by `createIsolationTable()` and dropped after each suite.
 */
export const isolationItems = pgTable(
  'test_isolation_items',
  {
    ...tenantColumns(),
    name: varchar('name', { length: 120 }).notNull(),
  },
  (t) => [
    unique('test_isolation_items_tenant_id_name_unique').on(t.tenantId, t.name),
    index('test_isolation_items_tenant_id_created_at_idx').on(
      t.tenantId,
      t.createdAt,
    ),
    tenantIsolation(),
  ],
);

export type IsolationItem = typeof isolationItems.$inferSelect;
