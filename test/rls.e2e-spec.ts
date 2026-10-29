import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, type PoolClient } from 'pg';
import { tenantScoped } from '../src/database/tenant-scoped';
import { Fixtures } from './support/fixtures';
import { isolationItems } from './support/isolation-items';
import {
  createIsolationTable,
  dropIsolationTable,
  ISOLATION_TABLE,
} from './support/isolation-table';

const INDEX = 'test_isolation_items_tenant_id_created_at_idx';

/**
 * Row-Level Security on a real Postgres, without the API: the same steps
 * TenantDatabase runs (`set local role app_tenant` + `app.tenant_id`).
 */
describe('Row-Level Security (integration)', () => {
  let fx: Fixtures;
  let shopA: string;
  let shopB: string;
  let itemA: string;
  let itemB: string;

  /** Runs `fn` as the app_tenant role inside shop `tenantId`, then rolls back. */
  async function asShop<R>(
    tenantId: string | null,
    fn: (client: PoolClient) => Promise<R>,
  ): Promise<R> {
    const client = await fx.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_tenant');
      if (tenantId) {
        await client.query("select set_config('app.tenant_id', $1, true)", [
          tenantId,
        ]);
      }
      return await fn(client);
    } finally {
      await client.query('rollback');
      client.release();
    }
  }

  async function rowOf(id: string) {
    const { rows } = await fx.pool.query<{ name: string; tenant_id: string }>(
      `select name, tenant_id from ${ISOLATION_TABLE} where id = $1`,
      [id],
    );
    return rows[0];
  }

  beforeAll(async () => {
    fx = new Fixtures();
    await createIsolationTable(fx.pool);
    shopA = await fx.tenant();
    shopB = await fx.tenant();

    // Seeded as the table owner, outside RLS.
    const rows = await fx.db
      .insert(isolationItems)
      .values([
        { tenantId: shopA, name: 'A rice' },
        { tenantId: shopA, name: 'A wheat' },
        { tenantId: shopB, name: 'B rice' },
      ])
      .returning();
    itemA = rows[0].id;
    itemB = rows[2].id;
  });

  afterAll(async () => {
    await fx.db
      .delete(isolationItems)
      .where(inArray(isolationItems.tenantId, [shopA, shopB]));
    await dropIsolationTable(fx.pool);
    await fx.cleanup();
  });

  it('the table was created with RLS enabled and the tenant policy', async () => {
    const { rows } = await fx.pool.query<{ relrowsecurity: boolean }>(
      'select relrowsecurity from pg_class where oid = $1::regclass',
      [ISOLATION_TABLE],
    );
    expect(rows[0].relrowsecurity).toBe(true);
  });

  describe('as shop A', () => {
    it('a select without any filter returns only shop A rows', async () => {
      const rows = await asShop(shopA, async (c) => {
        const res = await c.query<{ tenant_id: string; name: string }>(
          `select tenant_id, name from ${ISOLATION_TABLE}`,
        );
        return res.rows;
      });

      expect(rows.map((r) => r.name).sort()).toEqual(['A rice', 'A wheat']);
      expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([shopA]));
    });

    it("selecting shop B's row by id returns nothing", async () => {
      const count = await asShop(shopA, async (c) => {
        const res = await c.query(
          `select 1 from ${ISOLATION_TABLE} where id = $1`,
          [itemB],
        );
        return res.rowCount;
      });

      expect(count).toBe(0);
    });

    it('inserting a row for shop B is rejected (WITH CHECK)', async () => {
      await expect(
        asShop(shopA, (c) =>
          c.query(
            `insert into ${ISOLATION_TABLE} (tenant_id, name) values ($1, 'smuggled')`,
            [shopB],
          ),
        ),
      ).rejects.toThrow(/row-level security policy/);
    });

    it('moving its own row to shop B is rejected (WITH CHECK)', async () => {
      await expect(
        asShop(shopA, (c) =>
          c.query(
            `update ${ISOLATION_TABLE} set tenant_id = $1 where id = $2`,
            [shopB, itemA],
          ),
        ),
      ).rejects.toThrow(/row-level security policy/);
    });

    it("updating or deleting shop B's rows affects 0 rows", async () => {
      const [updated, deleted, deletedAll] = await asShop(shopA, async (c) => [
        (
          await c.query(
            `update ${ISOLATION_TABLE} set name = 'hacked' where id = $1`,
            [itemB],
          )
        ).rowCount,
        (await c.query(`delete from ${ISOLATION_TABLE} where id = $1`, [itemB]))
          .rowCount,
        (
          await c.query(`delete from ${ISOLATION_TABLE} where tenant_id = $1`, [
            shopB,
          ])
        ).rowCount,
      ]);

      expect([updated, deleted, deletedAll]).toEqual([0, 0, 0]);
      expect(await rowOf(itemB)).toEqual({ name: 'B rice', tenant_id: shopB });
    });

    it('can still write its own rows', async () => {
      const updated = await asShop(shopA, async (c) => {
        const res = await c.query(
          `update ${ISOLATION_TABLE} set name = name where id = $1`,
          [itemA],
        );
        return res.rowCount;
      });

      expect(updated).toBe(1);
    });

    it('tenantScoped() on the real table saves under the scoped shop even if tenantId is passed', async () => {
      const row = await asShop(shopA, async (c) => {
        // Same query builder a transaction has; enough for the helper.
        const tx = drizzle(c) as unknown as Parameters<typeof tenantScoped>[0];
        // The type omits tenantId, but a variable with extra keys still fits.
        const values = { name: 'tampered', tenantId: shopB };
        const [inserted] = await tenantScoped(tx, isolationItems, shopA).insert(
          values,
        );
        return inserted;
      });

      expect(row.tenantId).toBe(shopA);
    });
  });

  describe('without app.tenant_id', () => {
    it('a new connection sees 0 rows', async () => {
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        await client.query('begin');
        await client.query('set local role app_tenant');
        const res = await client.query(`select * from ${ISOLATION_TABLE}`);
        expect(res.rowCount).toBe(0);
      } finally {
        await client.query('rollback');
        await client.end();
      }
    });

    it('a pooled connection used by another shop before never leaks its rows', async () => {
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        // Shop A's earlier transaction on this same connection.
        await client.query('begin');
        await client.query("select set_config('app.tenant_id', $1, true)", [
          shopA,
        ]);
        await client.query('commit');

        await client.query('begin');
        await client.query('set local role app_tenant');
        // The setting is now '' (not NULL): Postgres either errors on the
        // uuid cast or, with nullif(), returns nothing. Never shop A's rows.
        const rows = await client
          .query<{ id: string }>(`select * from ${ISOLATION_TABLE}`)
          .then((res): unknown[] => res.rows)
          .catch((): unknown[] => []);
        expect(rows).toEqual([]);
      } finally {
        await client.query('rollback');
        await client.end();
      }
    });
  });

  describe('guard: every tenant table is protected', () => {
    it('each public table with a NOT NULL tenant_id has RLS and the tenant_isolation policy', async () => {
      const { rows } = await fx.pool.query<{
        table: string;
        rls: boolean;
        roles: string[] | null;
        cmd: string | null;
        qual: string | null;
        with_check: string | null;
      }>(
        `select c.relname as table, c.relrowsecurity as rls,
                p.roles::text[] as roles, p.cmd, p.qual, p.with_check
           from pg_attribute a
           join pg_class c on c.oid = a.attrelid
           join pg_namespace n on n.oid = c.relnamespace
           left join pg_policies p
             on p.schemaname = n.nspname and p.tablename = c.relname
            and p.policyname = 'tenant_isolation'
          where n.nspname = 'public'
            and c.relkind in ('r', 'p')
            and a.attname = 'tenant_id'
            and a.attnotnull
            and not a.attisdropped
          order by c.relname`,
      );

      // Proves the check really runs: the test table is in the list.
      expect(rows.map((r) => r.table)).toContain(ISOLATION_TABLE);
      // First real business table (migration 0005).
      expect(rows.map((r) => r.table)).toContain('tenant_settings');
      // Staff invites (migration 0006).
      expect(rows.map((r) => r.table)).toContain('invitations');
      // Traders and their khata (migration 0007).
      expect(rows.map((r) => r.table)).toEqual(
        expect.arrayContaining(['traders', 'ledger_entries']),
      );

      const unprotected = rows.filter(
        (r) =>
          !r.rls ||
          r.cmd !== 'ALL' ||
          !r.roles?.includes('app_tenant') ||
          !r.qual?.includes("current_setting('app.tenant_id'") ||
          !r.with_check?.includes("current_setting('app.tenant_id'"),
      );
      expect(unprotected.map((r) => r.table)).toEqual([]);
    });

    it('app_tenant cannot bypass RLS', async () => {
      const { rows } = await fx.pool.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        "select rolsuper, rolbypassrls from pg_roles where rolname = 'app_tenant'",
      );

      expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    });
  });

  describe('performance', () => {
    it('the shop list query uses the (tenant_id, created_at) index', async () => {
      const plan = await asShop(shopA, async (c) => {
        await c.query('set local enable_seqscan = off');
        const res = await c.query<{ 'QUERY PLAN': unknown }>(
          `explain (format json)
           select * from ${ISOLATION_TABLE}
            where tenant_id = $1 and deleted_at is null
            order by created_at desc
            limit 50`,
          [shopA],
        );
        return JSON.stringify(res.rows[0]['QUERY PLAN']);
      });

      expect(plan).toContain(`"Index Name":"${INDEX}"`);
      expect(plan).not.toContain('"Node Type":"Sort"');
    });
  });
});
