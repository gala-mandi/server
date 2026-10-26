import {
  index,
  inet,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    // Rotation family: reusing a revoked token revokes every session of the user.
    familyId: uuid('family_id').notNull(),
    deviceInfo: varchar('device_info', { length: 200 }),
    ip: inet('ip'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('refresh_tokens_user_id_idx').on(table.userId)],
);
