import { INestApplication } from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import { and, asc, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { karachiDate, previousDate } from '../src/common/time/karachi-date';
import { auditLogs, dailyRates } from '../src/database/schema';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import type { Commodity } from '../src/modules/commodities/commodities.dto';
import type { Rate } from '../src/modules/rates/rates.dto';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const NO_ACCESS = 'You do not have access to this action';

type Role = 'owner' | 'manager' | 'operator' | 'super_admin' | 'none';
const ROLES: Role[] = ['owner', 'manager', 'operator', 'super_admin', 'none'];

describe('Daily rates /rates (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;

  let shopA: string;
  const users = {} as Record<'ownerA' | 'manager', string>;
  const tokens = {} as Record<
    'ownerA' | 'ownerB' | 'manager' | 'operator' | 'superAdmin',
    string
  >;
  /** Ten commodities of shop A; one of shop B. */
  let itemsA: Commodity[];
  let itemB: Commodity;

  const today = () => karachiDate();
  const yesterday = () => previousDate(today());

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string | null) =>
    token ? req.set('Authorization', `Bearer ${token}`) : req;

  const getToday = (token: string | null) =>
    as(http().get('/rates/today'), token);
  const history = (token: string | null, query: Record<string, unknown> = {}) =>
    as(http().get('/rates'), token).query(query);
  const put = (token: string | null, date: string, body: object) =>
    as(http().put(`/rates/${date}`), token).send(body);

  const rate = (commodityId: string, over: Record<string, unknown> = {}) => ({
    commodityId,
    minRate: '4000',
    maxRate: '4200',
    ...over,
  });

  /** Login and everything else are limited per IP; every test comes from one IP. */
  function resetThrottle(): void {
    const storage = app.get<ThrottlerStorageService>(getStorageToken(), {
      strict: false,
    });
    storage.storage.clear();
    (
      Reflect.get(storage, 'hitExpirations') as Map<string, unknown> | undefined
    )?.clear();
  }

  async function login(identifier: string): Promise<string> {
    resetThrottle();
    const res = await http()
      .post('/auth/login')
      .send({ identifier, password: PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  async function commodity(token: string, name: string): Promise<Commodity> {
    const res = await as(http().post('/commodities'), token)
      .send({ name })
      .expect(201);
    return res.body as Commodity;
  }

  /** A fresh shop with a signed-in owner and `n` commodities. */
  async function newShop(n = 2) {
    const tenantId = await fx.tenant();
    const owner = await fx.user('owner', tenantId);
    const token = await login(owner.phone);
    const items: Commodity[] = [];
    for (let i = 0; i < n; i++) items.push(await commodity(token, `Item ${i}`));
    return { tenantId, token, items };
  }

  const rowsOf = (commodityIds: string[]) =>
    fx.db
      .select()
      .from(dailyRates)
      .where(inArray(dailyRates.commodityId, commodityIds))
      .orderBy(asc(dailyRates.rateDate), asc(dailyRates.createdAt));

  const auditOf = (entityId: string) =>
    fx.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entity, 'daily_rates'),
          eq(auditLogs.entityId, entityId),
        ),
      )
      .orderBy(asc(auditLogs.id));

  beforeAll(async () => {
    fx = new Fixtures();
    app = await createTestApp({
      override: (builder) =>
        builder
          .overrideProvider(OTP_SENDER)
          .useValue({ send: () => Promise.resolve() }),
    });

    shopA = await fx.tenant();
    const shopB = await fx.tenant();
    const ownerA = await fx.user('owner', shopA);
    const ownerB = await fx.user('owner', shopB);
    const manager = await fx.user('manager', shopA);
    const operator = await fx.user('operator', shopA);
    const superAdmin = await fx.user('super_admin', null);
    users.ownerA = ownerA.id;
    users.manager = manager.id;
    tokens.ownerA = await login(ownerA.phone);
    tokens.ownerB = await login(ownerB.phone);
    tokens.manager = await login(manager.phone);
    tokens.operator = await login(operator.phone);
    tokens.superAdmin = await login(superAdmin.phone);

    itemsA = [];
    for (let i = 0; i < 10; i++) {
      itemsA.push(await commodity(tokens.ownerA, `Rate item ${i}`));
    }
    itemB = await commodity(tokens.ownerB, 'Shop B item');
  });

  beforeEach(() => resetThrottle());

  afterAll(async () => {
    await app.close();
    // Rates, commodities and audit rows go with the shops.
    await fx.cleanup();
  });

  /* ---------------------------------------------------------------- */
  describe('PUT /rates/:date (bulk upsert)', () => {
    it('saves rates for 10 commodities in one request', async () => {
      const res = await put(tokens.ownerA, today(), {
        rates: itemsA.map((c, i) =>
          rate(c.id, { minRate: `${4000 + i}`, maxRate: `${4100 + i}.5` }),
        ),
      }).expect(200);

      expect(res.body.date).toBe(today());
      expect(res.body.data).toHaveLength(10);
      expect(res.body.data[0]).toEqual({
        id: expect.stringMatching(UUID),
        commodityId: itemsA[0].id,
        rateDate: today(),
        minRate: '4000.00',
        maxRate: '4100.50',
        avgRate: null,
        rateUnit: 'maund',
        createdAt: expect.stringMatching(ISO),
        updatedAt: expect.stringMatching(ISO),
      });
      const rows = await rowsOf(itemsA.map((c) => c.id));
      expect(rows).toHaveLength(10);
      expect(rows[0]).toMatchObject({
        tenantId: shopA,
        createdBy: users.ownerA,
        deletedAt: null,
      });
      const audit = await auditOf(rows[0].id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        tenantId: shopA,
        userId: users.ownerA,
        action: 'create',
      });
    });

    it('saving the same day again updates, no duplicates; only changes are audited', async () => {
      const { token, items } = await newShop(3);
      const [a, b, c] = items;
      await put(token, today(), {
        rates: [rate(a.id), rate(b.id)],
      }).expect(200);

      const res = await put(token, today(), {
        rates: [
          rate(a.id, { maxRate: '4300', avgRate: '4150', rateUnit: 'kg' }),
          rate(b.id),
          rate(c.id),
        ],
      }).expect(200);

      expect(res.body.data).toHaveLength(3);
      const rows = await rowsOf([a.id, b.id, c.id]);
      expect(rows).toHaveLength(3);
      const byCommodity = new Map(rows.map((r) => [r.commodityId, r]));
      expect(byCommodity.get(a.id)).toMatchObject({
        minRate: '4000.00',
        maxRate: '4300.00',
        avgRate: '4150.00',
        rateUnit: 'kg',
      });

      const auditA = await auditOf(byCommodity.get(a.id)!.id);
      expect(auditA.map((r) => r.action)).toEqual(['create', 'update']);
      expect(auditA[1].before).toEqual({
        maxRate: '4200.00',
        avgRate: null,
        rateUnit: 'maund',
      });
      expect(auditA[1].after).toEqual({
        maxRate: '4300.00',
        avgRate: '4150.00',
        rateUnit: 'kg',
      });
      // Saved again unchanged: nothing to audit.
      const auditB = await auditOf(byCommodity.get(b.id)!.id);
      expect(auditB.map((r) => r.action)).toEqual(['create']);
    });

    it('returns every rate of the day, not only the ones just saved', async () => {
      const { token, items } = await newShop(2);
      await put(token, today(), { rates: [rate(items[0].id)] }).expect(200);

      const res = await put(token, today(), {
        rates: [rate(items[1].id)],
      }).expect(200);

      expect((res.body.data as Rate[]).map((r) => r.commodityId)).toEqual([
        items[0].id,
        items[1].id,
      ]);
    });

    it('min > max → 400 on maxRate, nothing saved', async () => {
      const { token, items } = await newShop(2);

      const res = await put(token, today(), {
        rates: [
          rate(items[0].id),
          rate(items[1].id, { minRate: '4200', maxRate: '4199.99' }),
        ],
      }).expect(400);

      expect(res.body.message).toBe('Validation failed');
      expect(res.body.errors).toEqual([
        {
          field: 'rates.1.maxRate',
          message: 'Max rate must be at least the min rate',
        },
      ]);
      expect(await rowsOf(items.map((c) => c.id))).toEqual([]);
    });

    it('bad fields → 400 with field errors', async () => {
      const { token, items } = await newShop(1);

      const res = await put(token, today(), {
        rates: [
          rate(items[0].id, {
            minRate: 4000,
            avgRate: '1.234',
            rateUnit: 'bag',
          }),
        ],
      }).expect(400);

      expect(
        (res.body.errors as { field: string }[]).map((e) => e.field).sort(),
      ).toEqual(['rates.0.avgRate', 'rates.0.minRate', 'rates.0.rateUnit']);
    });

    it('the same commodity twice in one save → 400 on the second, nothing saved', async () => {
      const { token, items } = await newShop(1);

      const res = await put(token, today(), {
        rates: [rate(items[0].id), rate(items[0].id, { minRate: '1' })],
      }).expect(400);

      expect(res.body.errors).toEqual([
        {
          field: 'rates.1.commodityId',
          message: 'This commodity is already in the list',
        },
      ]);
      expect(await rowsOf([items[0].id])).toEqual([]);
    });

    it('an empty list or an unknown field → 400', async () => {
      await put(tokens.ownerA, today(), { rates: [] }).expect(400);
      await put(tokens.ownerA, today(), {
        rates: [rate(itemsA[0].id, { createdBy: users.manager })],
      }).expect(400);
    });

    it('a bad date → 400', async () => {
      for (const date of ['2026-02-30', 'today', '06-11-2026']) {
        const res = await put(tokens.ownerA, date, {
          rates: [rate(itemsA[0].id)],
        }).expect(400);
        expect(res.body.errors).toEqual([
          { field: 'date', message: 'Enter a date as YYYY-MM-DD' },
        ]);
      }
    });

    it('an unknown or deleted commodity → 400 on that row, nothing saved', async () => {
      const { token, items } = await newShop(2);
      await as(http().delete(`/commodities/${items[1].id}`), token).expect(204);

      const res = await put(token, today(), {
        rates: [rate(items[0].id), rate(UNKNOWN_ID), rate(items[1].id)],
      }).expect(400);

      expect(res.body.errors).toEqual([
        { field: 'rates.1.commodityId', message: 'Commodity not found' },
        { field: 'rates.2.commodityId', message: 'Commodity not found' },
      ]);
      expect(await rowsOf([items[0].id])).toEqual([]);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('past days', () => {
    it('the owner and a manager can change yesterday; it is audited', async () => {
      const item = itemsA[1];
      await put(tokens.ownerA, yesterday(), {
        rates: [rate(item.id)],
      }).expect(200);

      const res = await put(tokens.manager, yesterday(), {
        rates: [rate(item.id, { minRate: '3900' })],
      }).expect(200);

      expect(res.body.date).toBe(yesterday());
      const [row] = (await rowsOf([item.id])).filter(
        (r) => r.rateDate === yesterday(),
      );
      expect(row.minRate).toBe('3900.00');
      const audit = await auditOf(row.id);
      expect(audit.map((r) => [r.action, r.userId])).toEqual([
        ['create', users.ownerA],
        ['update', users.manager],
      ]);
      expect(audit[1].after).toEqual({ minRate: '3900.00' });
    });

    it('an operator changing yesterday → 403, nothing changed', async () => {
      const item = itemsA[2];
      await put(tokens.ownerA, yesterday(), {
        rates: [rate(item.id)],
      }).expect(200);

      const res = await put(tokens.operator, yesterday(), {
        rates: [rate(item.id, { minRate: '1' })],
      }).expect(403);

      // Operators have no rate.manage at all; the service also refuses
      // past days for anyone but the owner and managers.
      expect(res.body).toEqual({ statusCode: 403, message: NO_ACCESS });
      const [row] = (await rowsOf([item.id])).filter(
        (r) => r.rateDate === yesterday(),
      );
      expect(row.minRate).toBe('4000.00');
    });

    it('a date long ago works the same for the owner', async () => {
      const { token, items } = await newShop(1);

      await put(token, '2025-01-15', { rates: [rate(items[0].id)] }).expect(
        200,
      );

      expect((await rowsOf([items[0].id]))[0].rateDate).toBe('2025-01-15');
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /rates/today', () => {
    it("today's Pakistan date with today's rates and yesterday's as the starting point", async () => {
      const { token, items } = await newShop(3);
      const [a, b, c] = items;
      await put(token, yesterday(), {
        rates: [rate(a.id, { minRate: '3000', maxRate: '3100' }), rate(b.id)],
      }).expect(200);
      await put(token, today(), { rates: [rate(c.id)] }).expect(200);

      const res = await getToday(token).expect(200);

      expect(res.body.date).toBe(today());
      expect((res.body.data as Rate[]).map((r) => r.commodityId)).toEqual([
        c.id,
      ]);
      expect(res.body.yesterday.date).toBe(yesterday());
      expect(res.body.yesterday.data).toEqual([
        expect.objectContaining({
          commodityId: a.id,
          rateDate: yesterday(),
          minRate: '3000.00',
          maxRate: '3100.00',
        }),
        expect.objectContaining({ commodityId: b.id }),
      ]);
      // Yesterday is only shown: nothing was copied into today.
      expect(
        (await rowsOf([a.id, b.id])).filter((r) => r.rateDate === today()),
      ).toEqual([]);
    });

    it('a new shop: empty today and empty yesterday', async () => {
      const { token } = await newShop(0);

      const res = await getToday(token).expect(200);

      expect(res.body).toEqual({
        date: today(),
        data: [],
        yesterday: { date: yesterday(), data: [] },
      });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /rates (history)', () => {
    let token: string;
    let a: Commodity;
    let b: Commodity;
    const DAYS = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];

    beforeAll(async () => {
      const shop = await newShop(2);
      token = shop.token;
      [a, b] = shop.items;
      for (const day of DAYS) {
        await put(token, day, { rates: [rate(a.id), rate(b.id)] }).expect(200);
      }
    });

    it('newest day first, paged with meta', async () => {
      const res = await history(token, { limit: 3 }).expect(200);

      expect(res.body.meta).toEqual({ page: 1, limit: 3, total: 8 });
      expect((res.body.data as Rate[]).map((r) => r.rateDate)).toEqual([
        '2026-10-04',
        '2026-10-04',
        '2026-10-03',
      ]);
      const page3 = await history(token, { limit: 3, page: 3 }).expect(200);
      expect((page3.body.data as Rate[]).map((r) => r.rateDate)).toEqual([
        '2026-10-01',
        '2026-10-01',
      ]);
    });

    it('filters by commodity and inclusive from/to; sort=rateDate is oldest first', async () => {
      const res = await history(token, {
        commodity: a.id,
        from: '2026-10-02',
        to: '2026-10-03',
        sort: 'rateDate',
      }).expect(200);

      expect(res.body.meta.total).toBe(2);
      expect(
        (res.body.data as Rate[]).map((r) => [r.commodityId, r.rateDate]),
      ).toEqual([
        [a.id, '2026-10-02'],
        [a.id, '2026-10-03'],
      ]);
    });

    it('only from, or only to', async () => {
      const from = await history(token, { from: '2026-10-04' }).expect(200);
      expect(from.body.meta.total).toBe(2);
      const to = await history(token, {
        to: '2026-10-01',
        commodity: b.id,
      }).expect(200);
      expect((to.body.data as Rate[]).map((r) => r.commodityId)).toEqual([
        b.id,
      ]);
    });

    it('to before from, a bad date or a bad commodity → 400', async () => {
      const res = await history(token, {
        from: '2026-10-04',
        to: '2026-10-01',
      }).expect(400);
      expect(res.body.errors).toEqual([
        { field: 'to', message: '"to" must be on or after "from"' },
      ]);
      await history(token, { from: '2026-13-01' }).expect(400);
      await history(token, { commodity: 'gandum' }).expect(400);
    });

    it('an unknown commodity → empty list', async () => {
      const res = await history(token, { commodity: UNKNOWN_ID }).expect(200);
      expect(res.body).toEqual({
        data: [],
        meta: { page: 1, limit: 20, total: 0 },
      });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('permissions', () => {
    const tokenOf = (role: Role): string | null =>
      ({
        owner: tokens.ownerA,
        manager: tokens.manager,
        operator: tokens.operator,
        super_admin: tokens.superAdmin,
        none: null,
      })[role];

    /** View: every shop role; manage: owner and manager. */
    const expected = (role: Role, allowed: Role[], ok: number): number => {
      if (role === 'none') return 401;
      return allowed.includes(role) ? ok : 403;
    };
    const VIEW: Role[] = ['owner', 'manager', 'operator'];
    const MANAGE: Role[] = ['owner', 'manager'];

    it.each(ROLES)('GET /rates/today as %s', async (role) => {
      await getToday(tokenOf(role)).expect(expected(role, VIEW, 200));
    });

    it.each(ROLES)('GET /rates as %s', async (role) => {
      await history(tokenOf(role)).expect(expected(role, VIEW, 200));
    });

    it.each(ROLES)('PUT /rates/:date (today) as %s', async (role) => {
      const item = itemsA[9];
      const status = expected(role, MANAGE, 200);
      const minRate = { owner: '11', manager: '12' }[role as string];

      const res = await put(tokenOf(role), today(), {
        rates: [rate(item.id, { minRate: minRate ?? '1' })],
      }).expect(status);

      if (status === 403) {
        expect(res.body).toEqual({ statusCode: 403, message: NO_ACCESS });
      }
      const [row] = (await rowsOf([item.id])).filter(
        (r) => r.rateDate === today(),
      );
      if (status === 200) expect(row.minRate).toBe(`${minRate}.00`);
      else expect(row?.minRate).not.toBe('1.00');
    });
  });

  /* ---------------------------------------------------------------- */
  describe('tenant isolation', () => {
    beforeAll(async () => {
      await put(tokens.ownerB, today(), {
        rates: [rate(itemB.id, { minRate: '7777', maxRate: '8888' })],
      }).expect(200);
      await put(tokens.ownerB, '2026-09-01', {
        rates: [rate(itemB.id)],
      }).expect(200);
    });

    it("shop A's today never shows shop B's rates", async () => {
      const res = await getToday(tokens.ownerA).expect(200);

      const ids = [
        ...(res.body.data as Rate[]),
        ...(res.body.yesterday.data as Rate[]),
      ].map((r) => r.commodityId);
      expect(ids).not.toContain(itemB.id);
    });

    it("shop A's history never shows shop B's rates, even by commodity id", async () => {
      const all = await history(tokens.ownerA, { limit: 100 }).expect(200);
      expect(
        (all.body.data as Rate[]).some((r) => r.commodityId === itemB.id),
      ).toBe(false);

      const byId = await history(tokens.ownerA, {
        commodity: itemB.id,
      }).expect(200);
      expect(byId.body.meta.total).toBe(0);
    });

    it("shop A cannot write a rate for shop B's commodity → 400 not found; B unchanged", async () => {
      const res = await put(tokens.ownerA, today(), {
        rates: [rate(itemB.id, { minRate: '1', maxRate: '2' })],
      }).expect(400);

      expect(res.body.errors).toEqual([
        { field: 'rates.0.commodityId', message: 'Commodity not found' },
      ]);
      const rows = await rowsOf([itemB.id]);
      expect(rows.map((r) => r.minRate).sort()).toEqual(['4000.00', '7777.00']);
      expect(rows.every((r) => r.tenantId !== shopA)).toBe(true);
    });

    it('the same commodity, day and shop never clash across shops (unique is per shop)', async () => {
      const resB = await getToday(tokens.ownerB).expect(200);
      expect(
        (resB.body.data as Rate[]).map((r) => [r.commodityId, r.minRate]),
      ).toEqual([[itemB.id, '7777.00']]);
    });

    it('tenantId / tenant_id in the body or query are ignored', async () => {
      const { tenantId, token, items } = await newShop(1);

      await put(token, today(), {
        tenantId: shopA,
        tenant_id: shopA,
        rates: [rate(items[0].id)],
      }).expect(200);
      const [row] = await rowsOf([items[0].id]);
      expect(row.tenantId).toBe(tenantId);

      const res = await getToday(token).query({ tenant_id: shopA }).expect(200);
      expect((res.body.data as Rate[]).map((r) => r.commodityId)).toEqual([
        items[0].id,
      ]);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('commodity delete guard', () => {
    it('a commodity with daily rates → 409 COMMODITY_IN_USE, not deleted', async () => {
      const { token, items } = await newShop(2);
      await put(token, '2026-10-10', { rates: [rate(items[0].id)] }).expect(
        200,
      );

      const res = await as(
        http().delete(`/commodities/${items[0].id}`),
        token,
      ).expect(409);

      expect(res.body.code).toBe('COMMODITY_IN_USE');
      await as(http().get(`/commodities/${items[0].id}`), token).expect(200);
      // Without rates it can still be deleted.
      await as(http().delete(`/commodities/${items[1].id}`), token).expect(204);
    });
  });
});
