import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { auditLogs, tenants } from '../src/database/schema';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import type {
  ActivityFeed,
  InactiveShop,
  InactiveShopPage,
  NewShops,
  PlatformStats,
} from '../src/modules/stats/stats.dto';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';

const BASE = '/admin/stats';
const ROUTES = [
  BASE,
  `${BASE}/new-shops`,
  `${BASE}/activity`,
  `${BASE}/inactive-shops`,
];
const DAY_MS = 86_400_000;
/** A shop's money, written into an audit row; must never come back. */
const AMOUNT = '98765.43';

const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

/** `YYYY-MM` of a moment in Asia/Karachi. */
function karachiMonth(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}`;
}

describe('Platform stats /admin/stats (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;
  let admin: string;
  let adminId: string;
  /** Shop A's staff tokens by role. */
  const shopTokens: Record<string, string> = {};
  let shopA: string;
  let ownerA: { id: string; name: string };

  const http = () => request(app.getHttpServer());
  const get = (url: string, token: string | null = admin) => {
    const req = http().get(url);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  async function token(phone: string) {
    const res = await http()
      .post('/auth/login')
      .send({ identifier: phone, password: PASSWORD });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  async function summary(): Promise<PlatformStats> {
    const res = await get(BASE);
    expect(res.status).toBe(200);
    return res.body as PlatformStats;
  }

  async function newShops(months?: number): Promise<NewShops> {
    const res = await get(
      `${BASE}/new-shops${months ? `?months=${months}` : ''}`,
    );
    expect(res.status).toBe(200);
    return res.body as NewShops;
  }

  /** Every inactive shop, all pages. */
  async function allInactive(): Promise<InactiveShop[]> {
    const out: InactiveShop[] = [];
    for (let page = 1; ; page++) {
      const res = await get(`${BASE}/inactive-shops?limit=100&page=${page}`);
      expect(res.status).toBe(200);
      const body = res.body as InactiveShopPage;
      out.push(...body.data);
      if (out.length >= body.meta.total || !body.data.length) return out;
    }
  }

  const setCreatedAt = (id: string, createdAt: Date) =>
    fx.db.update(tenants).set({ createdAt }).where(eq(tenants.id, id));

  const audit = (
    tenantId: string,
    userId: string,
    createdAt = new Date(),
    action = 'update',
  ) =>
    fx.db.insert(auditLogs).values({
      tenantId,
      userId,
      entity: 'traders',
      entityId: tenantId,
      action,
      before: { openingBalance: '0.00' },
      after: { openingBalance: AMOUNT },
      ip: '10.0.0.1',
      userAgent: 'jest',
      createdAt,
    });

  beforeAll(async () => {
    fx = new Fixtures();
    app = await createTestApp({
      override: (builder) =>
        builder
          .overrideProvider(OTP_SENDER)
          .useValue({ send: () => Promise.resolve() }),
    });
    const superAdmin = await fx.user('super_admin', null);
    adminId = superAdmin.id;
    admin = await token(superAdmin.phone);

    shopA = await fx.tenant('active');
    for (const role of ['owner', 'manager', 'operator'] as const) {
      const user = await fx.user(role, shopA);
      if (role === 'owner') ownerA = user;
      shopTokens[role] = await token(user.phone);
    }
  });

  afterAll(async () => {
    await app.close();
    await fx.cleanup();
  });

  /* ---------------------------------------------------------------- */
  describe('role checks', () => {
    it.each(ROUTES)('%s needs a token (401)', async (url) => {
      expect((await get(url, null)).status).toBe(401);
    });

    it.each(
      ['owner', 'manager', 'operator'].flatMap((role) =>
        ROUTES.map((url) => [role, url]),
      ),
    )('%s gets 403 on %s', async (role, url) => {
      const res = await get(url, shopTokens[role]);
      expect(res.status).toBe(403);
      expect(res.body).not.toHaveProperty('shops');
      expect(res.body).not.toHaveProperty('data');
    });

    it.each(ROUTES)('the super-admin loads %s', async (url) => {
      expect((await get(url)).status).toBe(200);
    });

    it('reading stats writes nothing to the audit log', async () => {
      const before = await fx.db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(eq(auditLogs.userId, adminId));
      for (const url of ROUTES) await get(url);
      const after = await fx.db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(eq(auditLogs.userId, adminId));
      expect(after).toHaveLength(before.length);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /admin/stats', () => {
    it('counts shops by status; deleted shops are left out', async () => {
      const before = await summary();

      await fx.tenant('trial');
      await fx.tenant('trial');
      await fx.tenant('active');
      await fx.tenant('suspended');
      await fx.tenant('cancelled');
      const deleted = await fx.tenant('active');
      await fx.db
        .update(tenants)
        .set({ deletedAt: new Date() })
        .where(eq(tenants.id, deleted));

      const after = await summary();
      expect(after.shops).toEqual({
        total: before.shops.total + 5,
        trial: before.shops.trial + 2,
        active: before.shops.active + 1,
        suspended: before.shops.suspended + 1,
        cancelled: before.shops.cancelled + 1,
      });
      const { total, ...byStatus } = after.shops;
      expect(total).toBe(
        Object.values(byStatus).reduce((sum, n) => sum + n, 0),
      );
    });

    it('counts shop users; active = not deactivated, in a trial or active shop', async () => {
      const before = await summary();

      const trial = await fx.tenant('trial');
      const suspended = await fx.tenant('suspended');
      await fx.user('owner', trial); // total + active
      await fx.user('operator', trial, { isActive: false }); // total
      await fx.user('owner', suspended); // total
      await fx.user('manager', trial, { deletedAt: new Date() }); // none
      await fx.user('super_admin', null); // none: not a shop user

      const after = await summary();
      expect(after.users).toEqual({
        total: before.users.total + 3,
        active: before.users.active + 1,
      });
    });

    it('returns counts only', async () => {
      const body = await summary();
      expect(Object.keys(body).sort()).toEqual(['shops', 'users']);
      expect(Object.keys(body.users).sort()).toEqual(['active', 'total']);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /admin/stats/new-shops', () => {
    it('lists the last 12 Karachi months by default, oldest first, ending this month', async () => {
      const { data } = await newShops();
      expect(data).toHaveLength(12);
      expect(data.at(-1)!.month).toBe(karachiMonth(new Date()));
      const months = data.map((d) => d.month);
      expect([...months].sort()).toEqual(months);
      expect(new Set(months).size).toBe(12);
    });

    it('counts a new shop in its month; deleted shops are left out', async () => {
      const thisMonth = karachiMonth(new Date());
      // Mid-month a few months back, far from any month edge.
      const now = new Date();
      const past = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 15, 12),
      );
      const pastMonth = karachiMonth(past);

      const countIn = (body: NewShops, month: string) =>
        body.data.find((d) => d.month === month)!.count;
      const before = await newShops(6);

      await fx.tenant('trial');
      const old = await fx.tenant('active');
      await setCreatedAt(old, past);
      const gone = await fx.tenant('active');
      await fx.db
        .update(tenants)
        .set({ deletedAt: new Date() })
        .where(eq(tenants.id, gone));

      const after = await newShops(6);
      expect(countIn(after, thisMonth)).toBe(countIn(before, thisMonth) + 1);
      expect(countIn(after, pastMonth)).toBe(countIn(before, pastMonth) + 1);
    });

    it('honours ?months= and rejects bad values', async () => {
      expect((await newShops(3)).data).toHaveLength(3);
      expect((await newShops(36)).data).toHaveLength(36);
      for (const bad of ['0', '37', 'abc', '1.5']) {
        expect((await get(`${BASE}/new-shops?months=${bad}`)).status).toBe(400);
      }
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /admin/stats/activity', () => {
    it("shows the latest rows with shop and user, never the rows' values", async () => {
      await audit(shopA, ownerA.id);

      const res = await get(`${BASE}/activity?limit=5`);
      expect(res.status).toBe(200);
      const { data } = res.body as ActivityFeed;
      expect(data.length).toBeLessThanOrEqual(5);
      expect(data[0]).toEqual({
        id: expect.any(Number),
        tenant: { id: shopA, name: expect.any(String) },
        user: { id: ownerA.id, name: ownerA.name, role: 'owner' },
        entity: 'traders',
        entityId: shopA,
        action: 'update',
        createdAt: expect.any(String),
      });
      const ids = data.map((d) => d.id);
      expect([...ids].sort((a, b) => b - a)).toEqual(ids);

      // No amounts, no before/after, no ip or user agent.
      expect(res.text).not.toContain(AMOUNT);
      for (const row of data) {
        expect(Object.keys(row).sort()).toEqual(
          [
            'action',
            'createdAt',
            'entity',
            'entityId',
            'id',
            'tenant',
            'user',
          ].sort(),
        );
      }
    });

    it('shows platform rows without a shop', async () => {
      await fx.db.insert(auditLogs).values({
        tenantId: null,
        userId: adminId,
        entity: 'plans',
        entityId: adminId,
        action: 'create',
      });
      const { data } = (await get(`${BASE}/activity?limit=1`))
        .body as ActivityFeed;
      expect(data[0]).toMatchObject({
        tenant: null,
        user: { id: adminId, role: 'super_admin' },
        entity: 'plans',
      });
    });

    it('defaults to 20 rows and rejects a limit over 100', async () => {
      const { data } = (await get(`${BASE}/activity`)).body as ActivityFeed;
      expect(data.length).toBeLessThanOrEqual(20);
      expect((await get(`${BASE}/activity?limit=101`)).status).toBe(400);
      expect((await get(`${BASE}/activity?limit=0`)).status).toBe(400);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /admin/stats/inactive-shops', () => {
    it('lists trial/active shops with no own activity in 14 days, longest idle first', async () => {
      const created = daysAgo(30);
      const shop = async (status: 'trial' | 'active' | 'suspended') => {
        const id = await fx.tenant(status);
        await setCreatedAt(id, created);
        return id;
      };

      const idle = await shop('trial');
      const recentChange = await shop('active');
      await audit(recentChange, (await fx.user('operator', recentChange)).id);
      const recentLogin = await shop('active');
      await fx.user('owner', recentLogin, { lastLoginAt: daysAgo(1) });
      // The platform admin opening the shop is not the shop's activity.
      const adminOnly = await shop('active');
      await audit(adminOnly, adminId, new Date(), 'access');
      const oldChange = await shop('active');
      const twentyDaysAgo = daysAgo(20);
      await audit(
        oldChange,
        (await fx.user('manager', oldChange)).id,
        twentyDaysAgo,
      );
      const thirteenDays = await fx.tenant('active');
      await setCreatedAt(thirteenDays, daysAgo(13));
      const suspended = await shop('suspended');
      const brandNew = await fx.tenant('trial');

      const list = await allInactive();
      const byId = new Map(list.map((s) => [s.id, s]));

      expect(byId.get(idle)).toEqual({
        id: idle,
        name: expect.any(String),
        city: null,
        status: 'trial',
        lastActivityAt: created.toISOString(),
      });
      expect(byId.get(adminOnly)?.lastActivityAt).toBe(created.toISOString());
      expect(byId.get(oldChange)?.lastActivityAt).toBe(
        twentyDaysAgo.toISOString(),
      );
      for (const id of [
        recentChange,
        recentLogin,
        thirteenDays,
        suspended,
        brandNew,
        shopA,
      ]) {
        expect(byId.has(id)).toBe(false);
      }

      const times = list.map((s) => s.lastActivityAt);
      expect([...times].sort()).toEqual(times);
      const cutoff = daysAgo(14).getTime();
      expect(list.every((s) => Date.parse(s.lastActivityAt) < cutoff)).toBe(
        true,
      );
    });

    it('pages with { data, meta }', async () => {
      const res = await get(`${BASE}/inactive-shops?limit=1&page=1`);
      expect(res.status).toBe(200);
      const body = res.body as InactiveShopPage;
      expect(body.meta).toEqual({
        page: 1,
        limit: 1,
        total: expect.any(Number),
      });
      expect(body.data.length).toBe(Math.min(1, body.meta.total));
      expect((await get(`${BASE}/inactive-shops?limit=101`)).status).toBe(400);
    });
  });
});
