import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect, pgTable, varchar } from 'drizzle-orm/pg-core';
import { tenantColumns } from './tenant-table';
import {
  type TenantInsert,
  tenantScoped,
  type TenantUpdate,
} from './tenant-scoped';

const items = pgTable('items', {
  ...tenantColumns(),
  name: varchar('name', { length: 120 }).notNull(),
});

const SHOP_A = '11111111-1111-4111-8111-111111111111';
const SHOP_B = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';

const TENANT_FILTER = '"items"."tenant_id" = $1';
const NOT_DELETED = '"items"."deleted_at" is null';

interface Query {
  sql: string;
  params: unknown[];
}

type Tx = Parameters<typeof tenantScoped>[0];
type Insert = TenantInsert<typeof items>;
type Update = TenantUpdate<typeof items>;

// Builds SQL without a database connection.
const db = drizzle.mock();
const dialect = new PgDialect();
const scoped = () => tenantScoped(db as unknown as Tx, items, SHOP_A);
const toSQL = (builder: unknown): Query =>
  (builder as { toSQL: () => Query }).toSQL();

describe('tenantScoped()', () => {
  describe('where()', () => {
    it('filters on the tenant (as a parameter) and skips soft-deleted rows', () => {
      const query = dialect.sqlToQuery(scoped().where());

      expect(query.sql).toContain(TENANT_FILTER);
      expect(query.sql).toContain(NOT_DELETED);
      expect(query.params).toEqual([SHOP_A]);
    });

    it('keeps the tenant filter when extra conditions are added', () => {
      const query = dialect.sqlToQuery(scoped().where(eq(items.name, 'Ali')));

      expect(query.sql).toContain(TENANT_FILTER);
      expect(query.sql).toContain(NOT_DELETED);
      expect(query.sql).toContain('"items"."name" = $2');
      expect(query.params).toEqual([SHOP_A, 'Ali']);
    });

    it('byId() filters on tenant and id', () => {
      const query = dialect.sqlToQuery(scoped().byId(ITEM));

      expect(query.sql).toContain(TENANT_FILTER);
      expect(query.sql).toContain('"items"."id" = $2');
      expect(query.params).toEqual([SHOP_A, ITEM]);
    });
  });

  describe('reads', () => {
    it('findMany() selects only this shop', () => {
      const query = toSQL(scoped().findMany());

      expect(query.sql).toMatch(/^select .* from "items" where /);
      expect(query.sql).toContain(TENANT_FILTER);
      expect(query.sql).toContain(NOT_DELETED);
      expect(query.params).toEqual([SHOP_A]);
    });

    describe('findById() and count()', () => {
      // A fake pg client that records every query and returns no rows.
      const query = jest.fn<
        Promise<{ rows: unknown[]; fields: unknown[] }>,
        [{ text: string }, unknown[]]
      >(() => Promise.resolve({ rows: [], fields: [] }));
      const recording = drizzle({ client: { query } as never });
      const run = () => tenantScoped(recording as unknown as Tx, items, SHOP_A);
      const sent = () => ({
        text: query.mock.calls[0][0].text,
        values: query.mock.calls[0][1],
      });

      beforeEach(() => query.mockClear());

      it('findById() looks for the id inside this shop only', async () => {
        await expect(run().findById(ITEM)).resolves.toBeNull();

        expect(sent().text).toContain(TENANT_FILTER);
        expect(sent().text).toContain(NOT_DELETED);
        expect(sent().text).toContain('"items"."id" = $2');
        expect(sent().values.slice(0, 2)).toEqual([SHOP_A, ITEM]);
      });

      it('count() counts only this shop', async () => {
        await expect(run().count()).resolves.toBe(0);

        expect(sent().text).toMatch(/^select count\(\*\)::int from "items"/);
        expect(sent().text).toContain(TENANT_FILTER);
        expect(sent().values).toEqual([SHOP_A]);
      });
    });
  });

  describe('insert()', () => {
    it('sets tenant_id to the scoped shop', () => {
      const query = toSQL(scoped().insert({ name: 'Ali Traders' }));

      expect(query.sql).toMatch(/^insert into "items" \(.*"tenant_id"/);
      expect(query.params).toContain(SHOP_A);
      expect(query.sql).toMatch(/returning/);
    });

    it.each([['tenantId'], ['tenant_id']])(
      'ignores a %s passed by the caller',
      (key) => {
        const values = { name: 'Ali Traders', [key]: SHOP_B } as Insert;

        const query = toSQL(scoped().insert(values));

        expect(query.params).toContain(SHOP_A);
        expect(query.params).not.toContain(SHOP_B);
      },
    );

    it('sets the shop on every row of a batch', () => {
      const rows = [
        { name: 'A', tenantId: SHOP_B },
        { name: 'B', tenant_id: SHOP_B },
      ] as unknown as Insert[];

      const query = toSQL(scoped().insert(rows));

      expect(query.params.filter((p) => p === SHOP_A)).toHaveLength(2);
      expect(query.params).not.toContain(SHOP_B);
    });

    it('ignores an id passed by the caller (e.g. a spread request body)', () => {
      const values = { name: 'Ali', id: ITEM } as unknown as Insert;

      const query = toSQL(scoped().insert(values));

      expect(query.params).not.toContain(ITEM);
    });

    it('does not change the object the caller passed', () => {
      const values = { name: 'Ali', tenantId: SHOP_B } as Insert;

      scoped().insert(values);

      expect(values).toEqual({ name: 'Ali', tenantId: SHOP_B });
    });
  });

  describe('update()', () => {
    it('never changes the id', () => {
      const values = { name: 'New', id: SHOP_B } as unknown as Update;

      const query = toSQL(scoped().update(ITEM, values));
      const setClause = query.sql.split(' where ')[0];

      expect(setClause).not.toContain('"id"');
      expect(query.params).not.toContain(SHOP_B);
    });

    it('filters on tenant and id', () => {
      const query = toSQL(scoped().update(ITEM, { name: 'New' }));

      expect(query.sql).toMatch(/^update "items" set /);
      expect(query.sql).toMatch(/"items"\."tenant_id" = \$\d+/);
      expect(query.sql).toContain(NOT_DELETED);
      expect(query.sql).toMatch(/"items"\."id" = \$\d+/);
      expect(query.params).toEqual(
        expect.arrayContaining(['New', SHOP_A, ITEM]),
      );
    });

    it.each([['tenantId'], ['tenant_id']])(
      'never moves a row to another shop, even when %s is passed',
      (key) => {
        const values = { name: 'New', [key]: SHOP_B } as Update;

        const query = toSQL(scoped().update(ITEM, values));
        const setClause = query.sql.split(' where ')[0];

        expect(setClause).not.toContain('"tenant_id"');
        expect(query.params).not.toContain(SHOP_B);
      },
    );
  });

  describe('softDelete()', () => {
    it('sets deleted_at instead of deleting, inside this shop only', () => {
      const query = toSQL(scoped().softDelete(ITEM));

      expect(query.sql).toMatch(/^update "items" set .*"deleted_at" = now\(\)/);
      expect(query.sql).not.toMatch(/^delete/);
      expect(query.sql).toMatch(/"items"\."tenant_id" = \$\d+/);
      expect(query.sql).toContain(NOT_DELETED);
      expect(query.sql).toMatch(/"items"\."id" = \$\d+/);
      expect(query.params).toEqual(expect.arrayContaining([SHOP_A, ITEM]));
      expect(query.sql).toMatch(/returning "id"$/);
    });
  });
});
