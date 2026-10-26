import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema';

// Kept apart from database.module.ts so providers can import them without a
// circular import (database.module imports TenantDatabase).
export const PG_POOL = Symbol('PG_POOL');
export const DRIZZLE = Symbol('DRIZZLE');

export type Database = NodePgDatabase<typeof schema>;
