import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const tenantStatus = pgEnum('tenant_status', [
  'trial',
  'active',
  'suspended',
  'cancelled',
]);

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 120 }).notNull(),
  slug: varchar('slug', { length: 80 }).notNull().unique(),
  ownerName: varchar('owner_name', { length: 120 }).notNull(),
  phone: varchar('phone', { length: 20 }).notNull(),
  email: varchar('email', { length: 160 }),
  address: text('address'),
  city: varchar('city', { length: 80 }),
  logoUrl: text('logo_url'),
  status: tenantStatus('status').notNull().default('trial'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
