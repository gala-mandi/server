import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenantIsolation } from '../tenant-table';
import { tenants } from './tenants';
import { userRole, users } from './users';

/** A staff invite: single use, expires after 48 hours. */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    phone: varchar('phone', { length: 20 }).notNull(),
    role: userRole('role').notNull(),
    // SHA-256 of the token in the link; the token itself is never stored.
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('invitations_tenant_id_created_at_idx').on(
      table.tenantId,
      table.createdAt,
    ),
    tenantIsolation(),
  ],
);
