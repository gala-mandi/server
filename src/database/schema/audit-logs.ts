import {
  bigserial,
  index,
  inet,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    userId: uuid('user_id').references(() => users.id),
    entity: varchar('entity', { length: 40 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    // create | update | delete | restore | access (super-admin entering a shop)
    action: varchar('action', { length: 10 }).notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: inet('ip'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('audit_logs_tenant_id_entity_entity_id_idx').on(
      table.tenantId,
      table.entity,
      table.entityId,
    ),
    index('audit_logs_tenant_id_created_at_idx').on(
      table.tenantId,
      table.createdAt,
    ),
  ],
);
