import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { auditLogs, tenants } from '../src/database/schema';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';
import { isolationItems } from './support/isolation-items';
import { IsolationItemsModule } from './support/isolation-items.module';
import {
  createIsolationTable,
  dropIsolationTable,
} from './support/isolation-table';

/**
 * The ticket's scenarios against the API, on the test-only table, with two
 * seeded shops. Every endpoint goes through TenantDatabase + scoped().
 */
describe('Tenant isolation (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;
  let shopA: string;
  let shopB: string;
  let ownerA: string;
  let ownerB: string;
  let admin: string;
  let adminId: string;
  let itemA: string;
  let itemB: string;

  const http = () => request(app.getHttpServer());

  async function login(phone: string): Promise<string> {
    const res = await http()
      .post('/auth/login')
      .send({ identifier: phone, password: PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  const get = (token: string, url: string) =>
    http().get(url).set('Authorization', `Bearer ${token}`);
  const post = (token: string, url: string, body: object) =>
    http().post(url).set('Authorization', `Bearer ${token}`).send(body);
  const patch = (token: string, url: string, body: object) =>
    http().patch(url).set('Authorization', `Bearer ${token}`).send(body);
  const del = (token: string, url: string) =>
    http().delete(url).set('Authorization', `Bearer ${token}`);

  /** The row as stored, read as the table owner (outside RLS). */
  async function dbRow(id: unknown) {
    const [row] = await fx.db
      .select()
      .from(isolationItems)
      .where(eq(isolationItems.id, String(id)));
    return row;
  }

  async function newShopOwner(): Promise<{ shop: string; token: string }> {
    const shop = await fx.tenant();
    const owner = await fx.user('owner', shop);
    return { shop, token: await login(owner.phone) };
  }

  beforeAll(async () => {
    fx = new Fixtures();
    await createIsolationTable(fx.pool);
    app = await createTestApp({ imports: [IsolationItemsModule] });

    shopA = await fx.tenant();
    shopB = await fx.tenant();
    const [userA, userB, superAdmin] = await Promise.all([
      fx.user('owner', shopA),
      fx.user('owner', shopB),
      fx.user('super_admin', null),
    ]);
    adminId = superAdmin.id;
    [ownerA, ownerB, admin] = await Promise.all([
      login(userA.phone),
      login(userB.phone),
      login(superAdmin.phone),
    ]);

    itemA = (await post(ownerA, '/test-items', { name: 'Rice' }).expect(201))
      .body.id;
    itemB = (await post(ownerB, '/test-items', { name: 'Wheat' }).expect(201))
      .body.id;
  });

  afterAll(async () => {
    await app.close();
    await dropIsolationTable(fx.pool);
    await fx.cleanup();
  });

  describe('normal use', () => {
    it('owner of shop A lists items → only shop A items', async () => {
      const res = await get(ownerA, '/test-items').expect(200);

      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data.map((i: { id: string }) => i.id)).toContain(itemA);
      expect(res.body.data.map((i: { id: string }) => i.id)).not.toContain(
        itemB,
      );
      expect(
        res.body.data.every((i: { tenantId: string }) => i.tenantId === shopA),
      ).toBe(true);
      expect(res.body.meta.total).toBe(res.body.data.length);
    });

    it('owner of shop A reads its own item by id', async () => {
      const res = await get(ownerA, `/test-items/${itemA}`).expect(200);

      expect(res.body).toMatchObject({ id: itemA, tenantId: shopA });
    });

    it('creating a record sets tenant_id from the token', async () => {
      const res = await post(ownerA, '/test-items', { name: 'Maize' }).expect(
        201,
      );

      expect(res.body.tenantId).toBe(shopA);
      expect((await dbRow(res.body.id)).tenantId).toBe(shopA);
    });

    it('same name in shop A and shop B is allowed', async () => {
      const a = await post(ownerA, '/test-items', { name: 'Cotton' }).expect(
        201,
      );
      const b = await post(ownerB, '/test-items', { name: 'Cotton' }).expect(
        201,
      );

      expect(a.body.tenantId).toBe(shopA);
      expect(b.body.tenantId).toBe(shopB);
    });

    it('duplicate name inside one shop is rejected', async () => {
      await post(ownerA, '/test-items', { name: 'Barley' }).expect(201);

      const res = await post(ownerA, '/test-items', { name: 'Barley' }).expect(
        409,
      );
      expect(res.body.message).toBe('Name already used in this shop');
    });

    it('owner of shop A updates and soft-deletes its own item', async () => {
      const { body } = await post(ownerA, '/test-items', {
        name: 'Gram',
      }).expect(201);

      await patch(ownerA, `/test-items/${body.id}`, { name: 'Black gram' })
        .expect(200)
        .expect((res) => expect(res.body.name).toBe('Black gram'));
      await del(ownerA, `/test-items/${body.id}`).expect(204);

      await get(ownerA, `/test-items/${body.id}`).expect(404);
      // Soft delete: the row is still in the database.
      expect((await dbRow(body.id)).deletedAt).not.toBeNull();
    });
  });

  describe('attacks and mistakes', () => {
    it("shop A user opens shop B's item by id → 404", async () => {
      const res = await get(ownerA, `/test-items/${itemB}`).expect(404);

      expect(res.body).toEqual({ statusCode: 404, message: 'Item not found' });
    });

    it("shop A user updates shop B's item → 404, nothing changes", async () => {
      const before = await dbRow(itemB);

      await patch(ownerA, `/test-items/${itemB}`, { name: 'hacked' }).expect(
        404,
      );

      expect(await dbRow(itemB)).toEqual(before);
    });

    it("shop A user deletes shop B's item → 404, nothing changes", async () => {
      await del(ownerA, `/test-items/${itemB}`).expect(404);

      const row = await dbRow(itemB);
      expect(row.deletedAt).toBeNull();
      expect(row.name).toBe('Wheat');
      await get(ownerB, `/test-items/${itemB}`).expect(200);
    });

    it('guessing a random id → 404 on read, update and delete', async () => {
      const id = randomUUID();

      await get(ownerA, `/test-items/${id}`).expect(404);
      await patch(ownerA, `/test-items/${id}`, { name: 'x' }).expect(404);
      await del(ownerA, `/test-items/${id}`).expect(404);
    });

    it.each([['tenant_id'], ['tenantId']])(
      'body with %s of another shop → ignored, saved under own shop',
      async (key) => {
        const name = `Tampered ${key}`;

        const res = await post(ownerA, '/test-items', {
          name,
          [key]: shopB,
        }).expect(201);

        expect(res.body.tenantId).toBe(shopA);
        const [row] = await fx.db
          .select()
          .from(isolationItems)
          .where(eq(isolationItems.name, name));
        expect(row.tenantId).toBe(shopA);
      },
    );

    it('updating with tenant_id in the body does not move the row', async () => {
      await patch(ownerA, `/test-items/${itemA}`, {
        name: 'Rice',
        tenant_id: shopB,
        tenantId: shopB,
      }).expect(200);

      expect((await dbRow(itemA)).tenantId).toBe(shopA);
    });

    it('a raw query that forgets the helper still returns only shop A rows (RLS)', async () => {
      const res = await get(ownerA, '/test-items-raw').expect(200);

      const ids = res.body.data.map((r: { id: string }) => r.id);
      expect(ids).toContain(itemA);
      expect(ids).not.toContain(itemB);
      expect(
        res.body.data.every(
          (r: { tenant_id: string }) => r.tenant_id === shopA,
        ),
      ).toBe(true);
    });

    it.each([
      ['GET', '/test-items'],
      ['GET', '/test-items-raw'],
      ['POST', '/test-items'],
    ])(
      'token without tenantId (super_admin) on %s %s → 403',
      async (method, url) => {
        const req =
          method === 'GET'
            ? get(admin, url)
            : post(admin, url, { name: 'Admin item' });

        const res = await req.expect(403);
        expect(res.body.message).toBe('No shop selected');
      },
    );

    it('token without tenantId on an item by id → 403', async () => {
      await get(admin, `/test-items/${itemA}`).expect(403);
      await patch(admin, `/test-items/${itemA}`, { name: 'x' }).expect(403);
      await del(admin, `/test-items/${itemA}`).expect(403);
    });

    it('no token → 401', async () => {
      await http().get('/test-items').expect(401);
    });
  });

  describe('tenant status', () => {
    it('suspended shop → every shop endpoint returns 403, data stays', async () => {
      const { shop, token } = await newShopOwner();
      const { body } = await post(token, '/test-items', {
        name: 'Kept',
      }).expect(201);
      await fx.db
        .update(tenants)
        .set({ status: 'suspended' })
        .where(eq(tenants.id, shop));

      const calls = [
        () => get(token, '/test-items'),
        () => get(token, `/test-items/${body.id}`),
        () => get(token, '/test-items-raw'),
        () => post(token, '/test-items', { name: 'New' }),
        () => patch(token, `/test-items/${body.id}`, { name: 'Changed' }),
        () => del(token, `/test-items/${body.id}`),
      ];
      for (const call of calls) {
        const res = await call().expect(403);
        expect(res.body.code).toBe('TENANT_SUSPENDED');
      }

      const row = await dbRow(body.id);
      expect(row).toMatchObject({
        name: 'Kept',
        tenantId: shop,
        deletedAt: null,
      });
    });

    it('soft-deleted shop → its users cannot log in, data is kept', async () => {
      const shop = await fx.tenant();
      const owner = await fx.user('owner', shop);
      const token = await login(owner.phone);
      const { body } = await post(token, '/test-items', {
        name: 'Recoverable',
      }).expect(201);
      await fx.db
        .update(tenants)
        .set({ deletedAt: new Date() })
        .where(eq(tenants.id, shop));

      const res = await http()
        .post('/auth/login')
        .send({ identifier: owner.phone, password: PASSWORD })
        .expect(403);
      expect(res.body).toMatchObject({
        statusCode: 403,
        code: 'TENANT_SUSPENDED',
      });
      // An access token issued before the delete stops working too.
      await get(token, '/test-items').expect(403);

      const [tenant] = await fx.db
        .select()
        .from(tenants)
        .where(eq(tenants.id, shop));
      expect(tenant).toBeDefined();
      expect(await dbRow(body.id)).toMatchObject({
        name: 'Recoverable',
        deletedAt: null,
      });
    });
  });

  describe('super-admin withTenant()', () => {
    it("reads shop B's items and writes an audit row", async () => {
      const res = await get(admin, `/admin-test/tenants/${shopB}/items`).expect(
        200,
      );

      const ids = res.body.data.map((i: { id: string }) => i.id);
      expect(ids).toContain(itemB);
      expect(ids).not.toContain(itemA);

      const audit = await fx.db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.userId, adminId), eq(auditLogs.entityId, shopB)),
        );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        tenantId: shopB,
        userId: adminId,
        entity: 'tenant',
        entityId: shopB,
        action: 'access',
      });
    });

    it('unknown shop → 404 and no audit row', async () => {
      const id = randomUUID();

      await get(admin, `/admin-test/tenants/${id}/items`).expect(404);

      const audit = await fx.db
        .select()
        .from(auditLogs)
        .where(inArray(auditLogs.entityId, [id]));
      expect(audit).toHaveLength(0);
    });

    it('a shop owner calling the admin endpoint → 403, no audit row', async () => {
      const before = await fx.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, shopA));

      await get(ownerB, `/admin-test/tenants/${shopA}/items`).expect(403);

      const after = await fx.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, shopA));
      expect(after).toHaveLength(before.length);
    });
  });
});
