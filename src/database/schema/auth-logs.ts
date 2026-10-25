import {
  bigserial,
  index,
  inet,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const authLogs = pgTable(
  'auth_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').references(() => users.id),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    // login | logout | failed | refresh | locked | reset
    action: varchar('action', { length: 20 }).notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('auth_logs_tenant_id_created_at_idx').on(
      table.tenantId,
      table.createdAt,
    ),
  ],
);
