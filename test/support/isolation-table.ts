import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import type { Pool } from 'pg';
import { isolationItems } from './isolation-items';

export const ISOLATION_TABLE = 'test_isolation_items';

// Any constant works: it only serialises suites that create the table.
const LOCK_KEY = 4_242_001;

/**
 * Creates `test_isolation_items` from its Drizzle definition with drizzle-kit's
 * own SQL generator (empty snapshot → this table), so the RLS policy, index
 * and constraints are exactly what `drizzle-kit generate` writes for a real
 * business table. Does nothing if the table already exists.
 */
export async function createIsolationTable(pool: Pool): Promise<void> {
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ isolationItems }),
  );

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const { rows } = await client.query<{ exists: boolean }>(
      'select to_regclass($1) is not null as exists',
      [`public.${ISOLATION_TABLE}`],
    );
    if (!rows[0].exists) {
      for (const statement of statements) await client.query(statement);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function dropIsolationTable(pool: Pool): Promise<void> {
  await pool.query(`drop table if exists "${ISOLATION_TABLE}"`);
}
