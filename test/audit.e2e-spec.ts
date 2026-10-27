import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Writable } from 'node:stream';
import type {
  DynamicModule,
  FactoryProvider,
  INestApplication,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import { LoggerModule, PARAMS_PROVIDER_TOKEN, type Params } from 'nestjs-pino';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type { RequestContext } from '../src/common/context/request-context';
import { auditLogs, authLogs, users } from '../src/database/schema';
import { TenantDatabase } from '../src/database/tenant-database';
import {
  OTP_SENDER,
  type OtpMessage,
} from '../src/modules/auth/otp/otp-sender';
import { createTestApp } from './create-app';
import { AuditTestModule } from './support/audit-test.module';
import { Fixtures, PASSWORD } from './support/fixtures';
import { isolationItems } from './support/isolation-items';
import { IsolationItemsModule } from './support/isolation-items.module';
import {
  createIsolationTable,
  dropIsolationTable,
  ISOLATION_TABLE,
} from './support/isolation-table';

const UA = 'GallaMandi-AuditTest/1.0 (e2e)';

type AuditRow = typeof auditLogs.$inferSelect;
interface ListedRow {
  id: number;
  userId: string | null;
  entity: string;
  entityId: string;
  action: string;
  createdAt: string;
}

/**
 * The app's own nestjs-pino factory from AppModule, so the test checks the
 * real redaction settings; only the level and the destination are changed.
 */
function appLoggerParams(): FactoryProvider<Params> {
  const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
  const logger = imports.find(
    (m): m is DynamicModule => (m as DynamicModule)?.module === LoggerModule,
  );
  const provider = logger?.providers?.find(
    (p): p is FactoryProvider<Params> =>
      typeof p === 'object' &&
      'provide' in p &&
      p.provide === PARAMS_PROVIDER_TOKEN,
  );
  if (!provider) throw new Error('LoggerModule params provider not found');
  return provider;
}

/** Every `.ts` file under `dir`, specs excluded. */
function sourceFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => join(dir, f));
}

// Drizzle hard delete (`tx.delete(table)`, `this.db\n  .delete(table)`) or raw SQL.
const HARD_DELETE =
  /\b(?:tx|trx|db|this\.db|this\.tx)\s*\.\s*delete\s*\(|\bdelete\s+from\b/i;
// Token / OTP cleanup in the auth module would be allowed here; none exists today.
const HARD_DELETE_ALLOWLIST: string[] = [];

describe('Audit log & soft delete (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;
  let tenantDb: TenantDatabase;
  let cls: ClsService<RequestContext>;
  const suiteStart = new Date(Date.now() - 1000);
  const sentCodes: OtpMessage[] = [];
  const pinoLines: string[] = [];

  let shopA: string;
  let shopB: string;
  let ownerAId: string;
  let ownerA: string;
  let ownerB: string;
  let managerA: string;
  let operatorA: string;
  let admin: string;
  let adminId: string;

  const http = () => request(app.getHttpServer());
  const auth = (req: request.Test, token: string) =>
    req.set('Authorization', `Bearer ${token}`).set('User-Agent', UA);
  const get = (token: string, url: string) => auth(http().get(url), token);
  const post = (token: string, url: string, body: object = {}) =>
    auth(http().post(url), token).send(body);
  const patch = (token: string, url: string, body: object) =>
    auth(http().patch(url), token).send(body);
  const del = (token: string, url: string) => auth(http().delete(url), token);

  async function loginFull(identifier: string, password = PASSWORD) {
    const res = await http()
      .post('/auth/login')
      .set('User-Agent', UA)
      .send({ identifier, password })
      .expect(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const cookie = cookies
      .find((c) => c.startsWith('refresh_token='))!
      .split(';')[0];
    return {
      accessToken: res.body.accessToken as string,
      cookie,
      refreshToken: cookie.slice('refresh_token='.length),
    };
  }
  const login = async (phone: string) => (await loginFull(phone)).accessToken;

  /** Audit rows of one record, oldest first. */
  const auditOf = (entityId: string): Promise<AuditRow[]> =>
    fx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, entityId))
      .orderBy(asc(auditLogs.id));

  async function dbItem(id: string) {
    const [row] = await fx.db
      .select()
      .from(isolationItems)
      .where(eq(isolationItems.id, id));
    return row;
  }

  async function createItem(token: string, name: string): Promise<string> {
    const res = await post(token, '/test-items', { name }).expect(201);
    return res.body.id as string;
  }

  /** Runs `fn` as if inside a request of `userId` in `tenantId`. */
  function asUser<R>(
    tenantId: string,
    userId: string,
    fn: () => Promise<R>,
  ): Promise<R> {
    return cls.run(() => {
      cls.set('tenantId', tenantId);
      cls.set('userId', userId);
      cls.set('role', 'owner');
      cls.set('ip', '10.1.2.3');
      cls.set('userAgent', UA);
      return fn();
    });
  }

  async function xmin(table: string, where: string, id: string) {
    const { rows } = await fx.pool.query<{ xmin: string }>(
      `select xmin::text as xmin from ${table} where ${where} = $1`,
      [id],
    );
    return rows.map((r) => r.xmin);
  }

  beforeAll(async () => {
    fx = new Fixtures();
    await createIsolationTable(fx.pool);

    const logger = appLoggerParams();
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        pinoLines.push(chunk.toString());
        callback();
      },
    });
    app = await createTestApp({
      imports: [IsolationItemsModule, AuditTestModule],
      override: (builder) =>
        builder
          .overrideProvider(OTP_SENDER)
          .useValue({
            send: (message: OtpMessage) => {
              sentCodes.push(message);
              return Promise.resolve();
            },
          })
          .overrideProvider(PARAMS_PROVIDER_TOKEN)
          .useFactory({
            inject: logger.inject,
            factory: async (...deps: unknown[]): Promise<Params> => {
              const params = await logger.useFactory(...deps);
              return {
                ...params,
                pinoHttp: [
                  { ...(params.pinoHttp as object), level: 'trace' },
                  sink,
                ],
              };
            },
          }),
    });
    tenantDb = app.get(TenantDatabase);
    cls = app.get(ClsService);

    shopA = await fx.tenant();
    shopB = await fx.tenant();
    const [oA, oB, mA, opA, superAdmin] = await Promise.all([
      fx.user('owner', shopA),
      fx.user('owner', shopB),
      fx.user('manager', shopA),
      fx.user('operator', shopA),
      fx.user('super_admin', null),
    ]);
    ownerAId = oA.id;
    adminId = superAdmin.id;
    [ownerA, ownerB, managerA, operatorA, admin] = await Promise.all([
      login(oA.phone),
      login(oB.phone),
      login(mA.phone),
      login(opA.phone),
      login(superAdmin.phone),
    ]);
  });

  afterAll(async () => {
    await app.close();
    await dropIsolationTable(fx.pool);
    await fx.cleanup();
  });

  describe('every write produces one audit row', () => {
    it('create, update, soft delete and restore each write exactly one row', async () => {
      const id = await createItem(ownerA, 'old');
      await patch(ownerA, `/test-items/${id}`, { name: 'new' }).expect(200);
      await del(ownerA, `/test-items/${id}`).expect(204);
      await post(ownerA, `/records/${ISOLATION_TABLE}/${id}/restore`).expect(
        200,
      );

      const rows = await auditOf(id);

      expect(rows.map((r) => r.action)).toEqual([
        'create',
        'update',
        'delete',
        'restore',
      ]);
      for (const row of rows) {
        expect(row).toMatchObject({
          tenantId: shopA,
          userId: ownerAId,
          entity: ISOLATION_TABLE,
          entityId: id,
          userAgent: UA,
        });
        expect(row.ip).toMatch(/127\.0\.0\.1|::1/);
      }
      const [create, update, remove, restore] = rows;
      expect(create.before).toBeNull();
      expect(create.after).toMatchObject({
        id,
        tenantId: shopA,
        name: 'old',
        deletedAt: null,
      });
      // "Operator edits a purchase weight → log shows old and new."
      expect(update.before).toEqual({ name: 'old' });
      expect(update.after).toEqual({ name: 'new' });
      expect(remove.before).toMatchObject({ id, name: 'new', deletedAt: null });
      expect(remove.after).toBeNull();
      expect(restore.before).toBeNull();
      expect(restore.after).toMatchObject({ id, name: 'new', deletedAt: null });
    });

    it('an operator edit is logged with the operator as the user', async () => {
      const id = await createItem(operatorA, 'Weight 400');
      await patch(operatorA, `/test-items/${id}`, {
        name: 'Weight 420',
      }).expect(200);

      const [, update] = await auditOf(id);
      const [operator] = await fx.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, shopA), eq(users.role, 'operator')));

      expect(update).toMatchObject({
        action: 'update',
        userId: operator.id,
        before: { name: 'Weight 400' },
        after: { name: 'Weight 420' },
      });
      expect(update.createdAt).toBeInstanceOf(Date);
    });

    it('an update that changes nothing writes no audit row', async () => {
      const id = await createItem(ownerA, 'Same');
      await patch(ownerA, `/test-items/${id}`, { name: 'Same' }).expect(200);

      expect((await auditOf(id)).map((r) => r.action)).toEqual(['create']);
    });

    it('failed writes (unknown or other shop id) write no audit row', async () => {
      const itemB = await createItem(ownerB, 'B only');
      const missing = randomUUID();

      await patch(ownerA, `/test-items/${itemB}`, { name: 'x' }).expect(404);
      await del(ownerA, `/test-items/${itemB}`).expect(404);
      await patch(ownerA, `/test-items/${missing}`, { name: 'x' }).expect(404);
      await del(ownerA, `/test-items/${missing}`).expect(404);

      expect((await auditOf(itemB)).map((r) => r.action)).toEqual(['create']);
      expect(await auditOf(missing)).toEqual([]);
    });
  });

  describe('write → audit row in the same transaction', () => {
    it('the change and its audit row are written by one transaction', async () => {
      const { id, txid } = await asUser(shopA, ownerAId, () =>
        tenantDb.transaction(async ({ tx, scoped }) => {
          const [row] = await scoped(isolationItems).insert({ name: 'Tx' });
          const result = await tx.execute<{ txid: string }>(
            sql`select pg_current_xact_id()::xid::text as txid`,
          );
          return { id: row.id, txid: result.rows[0].txid };
        }),
      );

      expect(await xmin(ISOLATION_TABLE, 'id', id)).toEqual([txid]);
      expect(await xmin('audit_logs', 'entity_id', id)).toEqual([txid]);
      expect(await auditOf(id)).toEqual([
        expect.objectContaining({
          action: 'create',
          userId: ownerAId,
          ip: '10.1.2.3',
          userAgent: UA,
        }),
      ]);
    });

    it('an HTTP update and its audit row share the transaction too', async () => {
      const id = await createItem(ownerA, 'Tx http');
      await patch(ownerA, `/test-items/${id}`, { name: 'Tx http 2' }).expect(
        200,
      );

      const [itemXmin] = await xmin(ISOLATION_TABLE, 'id', id);
      const { rows } = await fx.pool.query<{ xmin: string }>(
        `select xmin::text as xmin from audit_logs where entity_id = $1 and action = 'update'`,
        [id],
      );
      expect(rows).toEqual([{ xmin: itemXmin }]);
    });

    it('when the audit insert fails, the business write is rolled back', async () => {
      // user_id has a foreign key to users: an unknown user makes the
      // audit insert itself fail, after the item insert succeeded.
      const name = `Rolled back ${randomUUID()}`;

      await expect(
        asUser(shopA, randomUUID(), () =>
          tenantDb.transaction(({ scoped }) =>
            scoped(isolationItems).insert({ name }),
          ),
        ),
      ).rejects.toThrow();

      const rows = await fx.db
        .select()
        .from(isolationItems)
        .where(eq(isolationItems.name, name));
      expect(rows).toEqual([]);
    });

    it('when the transaction fails after the write, both are gone', async () => {
      let id = '';

      await expect(
        asUser(shopA, ownerAId, () =>
          tenantDb.transaction(async ({ scoped }) => {
            const [row] = await scoped(isolationItems).insert({
              name: 'Never saved',
            });
            id = row.id;
            expect(await auditOf(id)).toEqual([]); // not visible outside yet
            throw new Error('later step failed');
          }),
        ),
      ).rejects.toThrow('later step failed');

      expect(id).not.toBe('');
      expect(await dbItem(id)).toBeUndefined();
      expect(await auditOf(id)).toEqual([]);
    });
  });

  describe('soft delete and restore', () => {
    const restore = (token: string, id: string, entity = ISOLATION_TABLE) =>
      post(token, `/records/${entity}/${id}/restore`);

    it('a deleted record is hidden but still in the DB, and the owner restores it', async () => {
      const id = await createItem(ownerA, 'Trader Akram');

      await del(ownerA, `/test-items/${id}`).expect(204);

      await get(ownerA, `/test-items/${id}`).expect(404);
      const list = await get(ownerA, '/test-items').expect(200);
      expect(list.body.data.map((i: { id: string }) => i.id)).not.toContain(id);
      expect((await dbItem(id)).deletedAt).toBeInstanceOf(Date);

      const res = await restore(ownerA, id).expect(200);

      expect(res.body).toEqual({ id, restored: true });
      await get(ownerA, `/test-items/${id}`).expect(200);
      const after = await get(ownerA, '/test-items').expect(200);
      expect(after.body.data.map((i: { id: string }) => i.id)).toContain(id);
      expect((await dbItem(id)).deletedAt).toBeNull();
    });

    it("deleted trader's old purchases still show the name in reports", async () => {
      const id = await createItem(ownerA, 'Trader Bashir');
      await del(ownerA, `/test-items/${id}`).expect(204);

      const res = await get(ownerA, `/test-items-report/${id}`).expect(200);

      expect(res.body).toEqual({
        report: { id, name: 'Trader Bashir' },
        findById: null,
      });
    });

    it('whereWithDeleted() still stays inside the shop', async () => {
      const itemB = await createItem(ownerB, 'Trader B report');
      await del(ownerB, `/test-items/${itemB}`).expect(204);

      const res = await get(ownerA, `/test-items-report/${itemB}`).expect(200);

      expect(res.body).toEqual({ report: null, findById: null });
    });

    it('restoring a record that is not deleted (or twice) is 404', async () => {
      const id = await createItem(ownerA, 'Trader Chaudhry');
      await restore(ownerA, id).expect(404);
      await del(ownerA, `/test-items/${id}`).expect(204);
      await restore(ownerA, id).expect(200);

      const res = await restore(ownerA, id).expect(404);

      expect(res.body.message).toBe('Nothing to restore');
      expect((await auditOf(id)).map((r) => r.action)).toEqual([
        'create',
        'delete',
        'restore',
      ]);
    });

    it('an unknown record type is 404', async () => {
      const res = await restore(ownerA, randomUUID(), 'traders_x').expect(404);

      expect(res.body.message).toBe('Unknown record type');
    });

    it('an unknown id is 404 and a malformed id is 400', async () => {
      await restore(ownerA, randomUUID()).expect(404);
      await restore(ownerA, 'not-a-uuid').expect(400);
    });

    it.each([
      ['manager', () => managerA],
      ['operator', () => operatorA],
      ['super_admin', () => admin],
    ])('%s cannot restore (403) and nothing changes', async (_role, token) => {
      const id = await createItem(ownerA, `Trader restore ${_role}`);
      await del(ownerA, `/test-items/${id}`).expect(204);

      await restore(token(), id).expect(403);

      expect((await dbItem(id)).deletedAt).toBeInstanceOf(Date);
      expect((await auditOf(id)).map((r) => r.action)).toEqual([
        'create',
        'delete',
      ]);
    });

    it("another shop's deleted record is 404 and stays deleted", async () => {
      const itemB = await createItem(ownerB, 'Trader B deleted');
      await del(ownerB, `/test-items/${itemB}`).expect(204);

      await restore(ownerA, itemB).expect(404);

      expect((await dbItem(itemB)).deletedAt).toBeInstanceOf(Date);
      expect((await auditOf(itemB)).map((r) => r.action)).toEqual([
        'create',
        'delete',
      ]);
      await get(ownerB, `/test-items/${itemB}`).expect(404);
    });

    it('no request without a token', async () => {
      await http()
        .post(`/records/${ISOLATION_TABLE}/${randomUUID()}/restore`)
        .expect(401);
    });
  });

  describe('audit log list', () => {
    // A fresh shop with a known history: owner creates X, renames X,
    // manager creates Y, owner deletes Y.
    let shopL: string;
    let ownerL: string;
    let ownerLId: string;
    let managerL: string;
    let managerLId: string;
    let operatorL: string;
    let itemX: string;
    let itemY: string;
    let itemB: string;

    const list = (token: string, query = '') =>
      get(token, `/audit-logs${query}`);
    const rows = (body: unknown) => (body as { data: ListedRow[] }).data;
    const ids = (body: unknown) => rows(body).map((r) => r.entityId);

    beforeAll(async () => {
      shopL = await fx.tenant();
      const [o, m, op] = await Promise.all([
        fx.user('owner', shopL),
        fx.user('manager', shopL),
        fx.user('operator', shopL),
      ]);
      ownerLId = o.id;
      managerLId = m.id;
      [ownerL, managerL, operatorL] = await Promise.all([
        login(o.phone),
        login(m.phone),
        login(op.phone),
      ]);

      itemX = await createItem(ownerL, 'Wheat X');
      await patch(ownerL, `/test-items/${itemX}`, { name: 'Wheat X2' }).expect(
        200,
      );
      itemY = await createItem(managerL, 'Rice Y');
      await del(ownerL, `/test-items/${itemY}`).expect(204);
      itemB = await createItem(ownerB, 'Shop B secret item');
    });

    it("owner sees only their shop's rows, newest first", async () => {
      const res = await list(ownerL).expect(200);

      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 4 });
      expect(res.body.data.map((r: ListedRow) => r.action)).toEqual([
        'delete',
        'create',
        'update',
        'create',
      ]);
      expect(ids(res.body)).toEqual([itemY, itemY, itemX, itemX]);
      const times = res.body.data.map((r: ListedRow) =>
        Date.parse(r.createdAt),
      );
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      expect(res.body.data[2]).toMatchObject({
        userId: ownerLId,
        entity: ISOLATION_TABLE,
        before: { name: 'Wheat X' },
        after: { name: 'Wheat X2' },
        userAgent: UA,
      });
    });

    it("shop A owner can't see shop B rows, not even by entityId", async () => {
      const all = await list(ownerL, '?limit=100').expect(200);
      expect(ids(all.body)).not.toContain(itemB);

      const byId = await list(ownerL, `?entityId=${itemB}`).expect(200);
      expect(byId.body).toEqual({
        data: [],
        meta: { page: 1, limit: 20, total: 0 },
      });

      const fromB = await list(ownerB, `?entityId=${itemB}`).expect(200);
      expect(fromB.body.meta.total).toBe(1);
    });

    it('a tenant_id in the query is ignored', async () => {
      const res = await list(ownerL, `?tenant_id=${shopB}`).expect(200);

      expect(ids(res.body)).not.toContain(itemB);
      expect(res.body.meta.total).toBe(4);
    });

    it('filters by userId', async () => {
      const res = await list(ownerL, `?userId=${managerLId}`).expect(200);

      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0]).toMatchObject({
        action: 'create',
        entityId: itemY,
        userId: managerLId,
      });
    });

    it('filters by entity', async () => {
      const hit = await list(ownerL, `?entity=${ISOLATION_TABLE}`).expect(200);
      const miss = await list(ownerL, '?entity=traders').expect(200);

      expect(hit.body.meta.total).toBe(4);
      expect(miss.body.meta.total).toBe(0);
    });

    it('filters by entityId', async () => {
      const res = await list(ownerL, `?entityId=${itemX}`).expect(200);

      expect(res.body.data.map((r: ListedRow) => r.action)).toEqual([
        'update',
        'create',
      ]);
    });

    it('filters by action', async () => {
      const res = await list(ownerL, '?action=delete').expect(200);

      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].entityId).toBe(itemY);
    });

    it('combines filters', async () => {
      const res = await list(
        ownerL,
        `?userId=${ownerLId}&action=create`,
      ).expect(200);

      expect(ids(res.body)).toEqual([itemX]);
    });

    it('filters by from/to; a date-only "to" includes that whole day', async () => {
      const all = await list(ownerL).expect(200);
      const times = all.body.data.map((r: ListedRow) => r.createdAt);
      const newest = times[0] as string;
      const oldest = times[times.length - 1] as string;
      const day = (iso: string) => iso.slice(0, 10);
      const dayBefore = new Date(Date.parse(oldest) - 86_400_000)
        .toISOString()
        .slice(0, 10);

      const total = async (query: string) =>
        (await list(ownerL, query).expect(200)).body.meta.total as number;

      // Rows were written "today": a plain date would mean midnight and
      // exclude them; the whole day must be included.
      expect(await total(`?to=${day(newest)}`)).toBe(4);
      expect(await total(`?from=${day(oldest)}&to=${day(newest)}`)).toBe(4);
      expect(await total(`?to=${dayBefore}`)).toBe(0);
      expect(await total(`?from=${oldest}`)).toBe(4);
      expect(
        await total(`?from=${new Date(Date.parse(newest) + 1).toISOString()}`),
      ).toBe(0);
      // A full timestamp "to" is exclusive and exact.
      expect(await total(`?to=${encodeURIComponent(oldest)}`)).toBe(0);
      expect(
        await total(`?to=${new Date(Date.parse(newest) + 1).toISOString()}`),
      ).toBe(4);
    });

    it('rejects invalid filters with 400', async () => {
      await list(ownerL, '?to=yesterday').expect(400);
      await list(ownerL, '?from=not-a-date').expect(400);
      await list(ownerL, '?userId=nope').expect(400);
      await list(ownerL, '?action=drop').expect(400);
    });

    it('pages with meta; limit is at most 100', async () => {
      const first = await list(ownerL, '?limit=2&page=1').expect(200);
      const second = await list(ownerL, '?limit=2&page=2').expect(200);
      const third = await list(ownerL, '?limit=2&page=3').expect(200);

      expect(first.body.meta).toEqual({ page: 1, limit: 2, total: 4 });
      expect(second.body.meta).toEqual({ page: 2, limit: 2, total: 4 });
      expect(first.body.data).toHaveLength(2);
      expect(second.body.data).toHaveLength(2);
      expect(third.body.data).toEqual([]);
      const firstIds = rows(first.body).map((r) => r.id);
      const secondIds = rows(second.body).map((r) => r.id);
      expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
      expect(Math.min(...firstIds)).toBeGreaterThan(Math.max(...secondIds));

      await list(ownerL, '?limit=100').expect(200);
      await list(ownerL, '?limit=101').expect(400);
      await list(ownerL, '?page=0').expect(400);
    });

    it.each([
      ['manager', () => managerL],
      ['operator', () => operatorL],
      ['super_admin', () => admin],
    ])('%s cannot read /audit-logs (403)', async (_role, token) => {
      await list(token()).expect(403);
    });

    it('no token → 401', async () => {
      await http().get('/audit-logs').expect(401);
    });

    describe('super-admin: GET /admin/tenants/:tenantId/audit-logs', () => {
      const adminList = (token: string, tenantId: string, query = '') =>
        get(token, `/admin/tenants/${tenantId}/audit-logs${query}`);

      it("returns that shop's rows and writes an access row", async () => {
        const before = new Date(Date.now() - 1000);

        const res = await adminList(admin, shopB, '?limit=100').expect(200);

        expect(ids(res.body)).toContain(itemB);
        expect(ids(res.body)).not.toContain(itemX);
        expect(ids(res.body)).not.toContain(itemY);
        const access = await fx.db
          .select()
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.tenantId, shopB),
              eq(auditLogs.action, 'access'),
              gte(auditLogs.createdAt, before),
            ),
          );
        expect(access).toEqual([
          expect.objectContaining({
            userId: adminId,
            entity: 'tenant',
            entityId: shopB,
            userAgent: UA,
          }),
        ]);
      });

      it('applies the same filters', async () => {
        const res = await adminList(
          admin,
          shopL,
          `?entityId=${itemX}&action=update`,
        ).expect(200);

        expect(res.body.meta.total).toBe(1);
        expect(res.body.data[0]).toMatchObject({
          entityId: itemX,
          before: { name: 'Wheat X' },
          after: { name: 'Wheat X2' },
        });
      });

      it('owner → 403', async () => {
        await adminList(ownerL, shopL).expect(403);
        await adminList(ownerL, shopB).expect(403);
      });

      it('unknown shop → 404 (and no access row), malformed id → 400', async () => {
        const unknown = randomUUID();

        await adminList(admin, unknown).expect(404);
        await adminList(admin, 'not-a-uuid').expect(400);

        expect(
          await fx.db
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.entityId, unknown)),
        ).toEqual([]);
      });
    });
  });

  describe('passwords, tokens and codes never appear in any log', () => {
    it('login, change password and reset password leave no secret behind', async () => {
      const captured: string[] = [];
      const capture = (chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      };
      const stdout = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(capture);
      const stderr = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(capture);
      const firstPinoLine = pinoLines.length;

      const secrets: string[] = [];
      const changed = 'Changed-pass-77';
      const reset = 'Reset-pass-88';
      const wrong = 'Wrong-pass-99';
      let code = '';
      let userId = '';
      try {
        const shop = await fx.tenant();
        const owner = await fx.user('owner', shop);
        userId = owner.id;

        await http()
          .post('/auth/login')
          .set('User-Agent', UA)
          .send({ identifier: owner.phone, password: wrong })
          .expect(401);
        const first = await loginFull(owner.phone);
        secrets.push(first.accessToken, first.refreshToken);

        // A business write in the same session, so audit_logs has rows too.
        const id = await createItem(first.accessToken, 'After login');
        await patch(first.accessToken, `/test-items/${id}`, {
          name: 'After login 2',
        }).expect(200);

        const refreshed = await http()
          .post('/auth/refresh')
          .set('Cookie', first.cookie)
          .set('User-Agent', UA)
          .expect(200);
        const rotated = (refreshed.headers['set-cookie'] as unknown as string[])
          .find((c) => c.startsWith('refresh_token='))!
          .split(';')[0]
          .slice('refresh_token='.length);
        secrets.push(refreshed.body.accessToken as string, rotated);

        await post(first.accessToken, '/auth/change-password', {
          currentPassword: PASSWORD,
          newPassword: changed,
        }).expect(200);
        const second = await loginFull(owner.phone, changed);
        secrets.push(second.accessToken, second.refreshToken);

        sentCodes.length = 0;
        await http()
          .post('/auth/forgot-password')
          .set('User-Agent', UA)
          .send({ phone: owner.phone, channel: 'sms' })
          .expect(202);
        code = sentCodes[0].code;
        await http()
          .post('/auth/reset-password')
          .set('User-Agent', UA)
          .send({ phone: owner.phone, code, newPassword: reset })
          .expect(200);
        const third = await loginFull(owner.phone, reset);
        secrets.push(third.accessToken, third.refreshToken);
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }

      const [{ passwordHash }] = await fx.db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId));
      secrets.push(PASSWORD, changed, reset, wrong, passwordHash);
      expect(secrets.every((s) => typeof s === 'string' && s.length > 8)).toBe(
        true,
      );

      const auditRows = await fx.db
        .select()
        .from(auditLogs)
        .where(
          or(
            gte(auditLogs.createdAt, suiteStart),
            inArray(auditLogs.tenantId, [shopA, shopB]),
          ),
        );
      const authRows = await fx.db
        .select()
        .from(authLogs)
        .where(gte(authLogs.createdAt, suiteStart));
      const userAuthRows = authRows.filter((r) => r.userId === userId);
      expect([...new Set(userAuthRows.map((r) => r.action))].sort()).toEqual([
        'failed',
        'login',
        'refresh',
        'reset',
      ]);
      expect(auditRows.some((r) => r.userId === userId)).toBe(true);

      const pino = pinoLines.slice(firstPinoLine).join('');
      // The capture works: requests of this test were logged.
      expect(pino).toContain('/auth/reset-password');
      expect(pino).toContain('/auth/change-password');

      const sources = {
        audit_logs: JSON.stringify(auditRows),
        auth_logs: JSON.stringify(authRows),
        pino,
        console: captured.join(''),
      };
      const otp = new RegExp(`(?<![0-9A-Za-z])${code}(?![0-9A-Za-z])`);
      for (const [source, text] of Object.entries(sources)) {
        for (const secret of secrets) {
          expect({ source, leaked: text.includes(secret) }).toEqual({
            source,
            leaked: false,
          });
        }
        expect({ source, argon2: /\$argon2/.test(text) }).toEqual({
          source,
          argon2: false,
        });
        expect({ source, otp: otp.test(text) }).toEqual({ source, otp: false });
      }
    });
  });

  describe('no hard deletes in business modules', () => {
    const modulesDir = join(__dirname, '..', 'src', 'modules');

    it('the check recognises a hard delete', () => {
      expect(HARD_DELETE.test('await tx.delete(traders).where(x)')).toBe(true);
      expect(HARD_DELETE.test('this.db\n      .delete(refreshTokens)')).toBe(
        true,
      );
      expect(HARD_DELETE.test('sql`DELETE FROM traders`')).toBe(true);
      expect(HARD_DELETE.test('scoped(traders).softDelete(id)')).toBe(false);
      expect(HARD_DELETE.test('this.tables.delete(entity)')).toBe(false);
    });

    it('no module file deletes rows', () => {
      const files = sourceFiles(modulesDir);
      expect(files.length).toBeGreaterThan(0);

      const root = join(modulesDir, '..', '..');
      const offenders = files
        .filter((file) => HARD_DELETE.test(readFileSync(file, 'utf8')))
        .map((file) => relative(root, file))
        .filter((file) => !HARD_DELETE_ALLOWLIST.includes(file));

      expect(offenders).toEqual([]);
    });
  });
});
