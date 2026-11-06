import { randomUUID } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import Decimal from 'decimal.js';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { karachiDate, previousDate } from '../src/common/time/karachi-date';
import {
  auditLogs,
  ledgerEntries,
  numberSequences,
  purchaseItems,
  purchases,
  tenantSettings,
} from '../src/database/schema';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import type { Commodity } from '../src/modules/commodities/commodities.dto';
import { LedgerReconciliation } from '../src/modules/ledger/ledger-reconciliation.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { financialYear } from '../src/modules/numbering/bill-number';
import type {
  Purchase,
  PurchaseSummary,
} from '../src/modules/purchases/purchases.dto';
import type { Trader } from '../src/modules/traders/traders.dto';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const TODAY = karachiDate();
const YESTERDAY = previousDate(TODAY);
// Same financial year as today (but on 1–3 July), so one bill series.
const EARLIER = previousDate(previousDate(YESTERDAY));
const FY = financialYear(TODAY, null);
const bill = (n: number) => `PUR-${FY}-${String(n).padStart(6, '0')}`;

type Token = 'ownerA' | 'ownerB' | 'manager' | 'operator';

describe('Purchases /purchases (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;
  let shopA: string;
  let shopB: string;
  const tokens = {} as Record<Token, string>;

  /** Shop A's master data. */
  let wheat: Commodity;
  let kissan: Trader;

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string | null) =>
    token ? req.set('Authorization', `Bearer ${token}`) : req;

  /** 1,000 kg wheat at Rs 4,000/maund, 10 bags. */
  const item = (over: Record<string, unknown> = {}) => ({
    commodityId: wheat.id,
    bags: 10,
    weightKg: '1000',
    rate: '4000',
    rateUnit: 'maund',
    ...over,
  });

  const create = (
    body: Record<string, unknown> = {},
    token = tokens.ownerA,
    key: string | null = randomUUID(),
  ) => {
    const req = as(http().post('/purchases'), token);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send({ traderId: kissan.id, items: [item()], ...body });
  };
  const created = async (
    body: Record<string, unknown> = {},
    token = tokens.ownerA,
  ): Promise<Purchase> =>
    (await create(body, token).expect(201)).body as Purchase;

  const get = (id: string, token = tokens.ownerA) =>
    as(http().get(`/purchases/${id}`), token);
  const list = (query: Record<string, unknown> = {}, token = tokens.ownerA) =>
    as(http().get('/purchases'), token).query(query);
  const patch = (id: string, body: object, token = tokens.ownerA) =>
    as(http().patch(`/purchases/${id}`), token).send(body);
  const cancel = (id: string, token = tokens.ownerA) =>
    as(http().post(`/purchases/${id}/cancel`), token);

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

  async function trader(
    body: Record<string, unknown> = {},
    token = tokens.ownerA,
  ): Promise<Trader> {
    const res = await as(http().post('/traders'), token)
      .send({
        type: 'kissan',
        name: `Kissan ${randomUUID().slice(0, 8)}`,
        ...body,
      })
      .expect(201);
    return res.body as Trader;
  }

  async function commodity(
    body: Record<string, unknown> = {},
    token = tokens.ownerA,
  ): Promise<Commodity> {
    const res = await as(http().post('/commodities'), token)
      .send({ name: `Gandum ${randomUUID().slice(0, 8)}`, ...body })
      .expect(201);
    return res.body as Commodity;
  }

  /** The khata balance (debit − credit) of a trader, via the API. */
  async function balance(traderId: string, token = tokens.ownerA) {
    const res = await as(http().get(`/ledger/${traderId}`), token).expect(200);
    return res.body.closingBalance as string;
  }

  const entriesOf = (sourceId: string) =>
    fx.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.sourceId, sourceId))
      .orderBy(asc(ledgerEntries.id));

  const purchasesIn = async (tenantId: string) =>
    (
      await fx.db
        .select({ n: count() })
        .from(purchases)
        .where(eq(purchases.tenantId, tenantId))
    )[0].n;

  /** A new shop with an owner, its own series and master data. */
  async function freshShop() {
    const shop = await fx.tenant();
    await fx.db.insert(tenantSettings).values({ tenantId: shop });
    const owner = await fx.user('owner', shop);
    const token = await login(owner.phone);
    return {
      shop,
      token,
      kissan: await trader({}, token),
      wheat: await commodity({}, token),
    };
  }

  beforeAll(async () => {
    fx = new Fixtures();
    app = await createTestApp({
      override: (builder) =>
        builder
          .overrideProvider(OTP_SENDER)
          .useValue({ send: () => Promise.resolve() }),
    });

    shopA = await fx.tenant();
    shopB = await fx.tenant();
    // Shop A: commission 2%, market fee 0.5%, labour Rs 20 per bag.
    await fx.db.insert(tenantSettings).values([
      {
        tenantId: shopA,
        defaultCommissionPct: '2',
        marketFeePct: '0.5',
        labourPerBag: '20',
      },
      { tenantId: shopB },
    ]);
    const ownerA = await fx.user('owner', shopA);
    const ownerB = await fx.user('owner', shopB);
    const manager = await fx.user('manager', shopA);
    const operator = await fx.user('operator', shopA);
    tokens.ownerA = await login(ownerA.phone);
    tokens.ownerB = await login(ownerB.phone);
    tokens.manager = await login(manager.phone);
    tokens.operator = await login(operator.phone);

    wheat = await commodity();
    kissan = await trader();
  });

  beforeEach(() => resetThrottle());

  afterAll(async () => {
    await app.close();
    await fx.cleanup();
  });

  /* ---------------------------------------------------------------- */
  describe('POST /purchases', () => {
    it('saves the purchase with its bill number; the kissan is credited with the net', async () => {
      const k = await trader();

      const res = await create(
        { traderId: k.id, notes: 'Lot 1' },
        tokens.operator,
      ).expect(201);
      const p = res.body as Purchase;

      expect(p).toEqual({
        id: expect.any(String),
        billNo: expect.stringMatching(new RegExp(`^PUR-${FY}-\\d{6}$`)),
        purchaseDate: TODAY,
        trader: { id: k.id, name: k.name },
        grossAmount: '100000.00',
        totalDeductions: '2700.00',
        rounding: '0.00',
        netAmount: '97300.00',
        paidAmount: '0.00',
        outstanding: '97300.00',
        status: 'posted',
        notes: 'Lot 1',
        items: [
          {
            id: expect.any(String),
            commodityId: wheat.id,
            commodityName: wheat.name,
            bags: 10,
            weightKg: '1000.000',
            rate: '4000.00',
            rateUnit: 'maund',
            amount: '100000.00',
          },
        ],
        charges: [
          {
            id: expect.any(String),
            type: 'commission',
            basis: 'percent',
            value: '2.00',
            amount: '2000.00',
          },
          {
            id: expect.any(String),
            type: 'market_fee',
            basis: 'percent',
            value: '0.50',
            amount: '500.00',
          },
          {
            id: expect.any(String),
            type: 'labour',
            basis: 'per_bag',
            value: '20.00',
            amount: '200.00',
          },
        ],
        createdBy: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(await balance(k.id)).toBe('-97300.00');
      expect(await entriesOf(p.id)).toEqual([
        expect.objectContaining({
          traderId: k.id,
          entryDate: TODAY,
          sourceType: 'purchase',
          debit: '0.00',
          credit: '97300.00',
          narration: `Purchase ${p.billNo}`,
        }),
      ]);
    });

    it('several items: summed before the net is rounded once', async () => {
      const p = await created({
        items: [item({ weightKg: '1000.333' }), item({ weightKg: '1000.333' })],
      });

      expect(p).toMatchObject({
        grossAmount: '200066.60',
        totalDeductions: '5401.66',
        rounding: '0.06',
        netAmount: '194665.00',
      });
      expect(p.items.map((i) => i.amount)).toEqual(['100033.30', '100033.30']);
      // The parchi adds up from the stored columns.
      expect(
        new Decimal(p.grossAmount)
          .minus(p.totalDeductions)
          .plus(p.rounding)
          .toFixed(2),
      ).toBe(p.netAmount);
    });

    it('keeps the items in the order typed', async () => {
      const weights = ['100', '200', '300', '400', '500', '600'];
      const p = await created({
        items: weights.map((weightKg) => item({ weightKg })),
      });
      expect(p.items.map((i) => i.weightKg)).toEqual(
        weights.map((w) => `${w}.000`),
      );
    });

    it('an amount paid on the same save is debited back to the kissan', async () => {
      const k = await trader();

      const p = await created({ traderId: k.id, paidAmount: '40000' });

      expect(p.paidAmount).toBe('40000.00');
      expect(await balance(k.id)).toBe('-57300.00');
      expect(
        (await entriesOf(p.id)).map((e) => [e.debit, e.credit, e.narration]),
      ).toEqual([
        ['0.00', '97300.00', `Purchase ${p.billNo}`],
        ['40000.00', '0.00', `Paid on purchase ${p.billNo}`],
      ]);
    });

    it('the commodity override and charges typed on the parchi win over the shop default', async () => {
      const cotton = await commodity({ commissionPct: '1.5' });

      const own = await created({ items: [item({ commodityId: cotton.id })] });
      const manual = await created({
        items: [item({ commodityId: cotton.id })],
        charges: { commissionPct: '0', labourPerBag: '25' },
      });

      expect(own.charges.map((c) => [c.type, c.value, c.amount])).toEqual([
        ['commission', '1.50', '1500.00'],
        ['market_fee', '0.50', '500.00'],
        ['labour', '20.00', '200.00'],
      ]);
      expect(manual.charges.map((c) => [c.type, c.value, c.amount])).toEqual([
        ['commission', '0.00', '0.00'],
        ['market_fee', '0.50', '500.00'],
        ['labour', '25.00', '250.00'],
      ]);
      expect(manual.netAmount).toBe('99250.00');
    });

    it('rates and charges are copied: later setting changes leave the bill as it was', async () => {
      const s = await freshShop();
      await fx.db
        .update(tenantSettings)
        .set({ defaultCommissionPct: '2' })
        .where(eq(tenantSettings.tenantId, s.shop));
      const p = (
        await create(
          { traderId: s.kissan.id, items: [item({ commodityId: s.wheat.id })] },
          s.token,
        ).expect(201)
      ).body as Purchase;

      await fx.db
        .update(tenantSettings)
        .set({ defaultCommissionPct: '5' })
        .where(eq(tenantSettings.tenantId, s.shop));

      const again = await get(p.id, s.token).expect(200);
      expect(again.body).toEqual(p);
    });

    it('a back-dated purchase (a paper bill entered late) is dated that day in the khata', async () => {
      const p = await created({ purchaseDate: YESTERDAY });
      expect(p.purchaseDate).toBe(YESTERDAY);
      expect((await entriesOf(p.id))[0].entryDate).toBe(YESTERDAY);
    });

    it('a tenant_id in the body is ignored', async () => {
      const p = await created({ tenant_id: shopB });
      expect(
        (
          await fx.db
            .select({ tenantId: purchases.tenantId })
            .from(purchases)
            .where(eq(purchases.id, p.id))
        )[0].tenantId,
      ).toBe(shopA);
    });

    describe('refused (400), nothing saved, no bill number used', () => {
      let s: Awaited<ReturnType<typeof freshShop>>;

      beforeAll(async () => {
        s = await freshShop();
      });

      const save = (body: Record<string, unknown>) =>
        create(
          {
            traderId: s.kissan.id,
            items: [item({ commodityId: s.wheat.id })],
            ...body,
          },
          s.token,
        );

      async function expectNothingSaved() {
        expect(await purchasesIn(s.shop)).toBe(0);
        expect(
          await fx.db
            .select()
            .from(numberSequences)
            .where(eq(numberSequences.tenantId, s.shop)),
        ).toEqual([]);
      }

      it('inactive kissan', async () => {
        const k = await trader({ isActive: false }, s.token);
        const res = await save({ traderId: k.id }).expect(400);
        expect(res.body.errors).toEqual([
          { field: 'traderId', message: 'This kissan is inactive' },
        ]);
        await expectNothingSaved();
      });

      it('inactive commodity', async () => {
        const c = await commodity({ isActive: false }, s.token);
        const res = await save({
          items: [
            item({ commodityId: s.wheat.id }),
            item({ commodityId: c.id }),
          ],
        }).expect(400);
        expect(res.body.errors).toEqual([
          {
            field: 'items.1.commodityId',
            message: 'This commodity is inactive',
          },
        ]);
        await expectNothingSaved();
      });

      it('a beopari is not a kissan', async () => {
        const b = await trader({ type: 'beopari' }, s.token);
        const res = await save({ traderId: b.id }).expect(400);
        expect(res.body.errors[0].field).toBe('traderId');
        await expectNothingSaved();
      });

      it('another shop’s kissan or commodity looks unknown', async () => {
        const res = await save({
          traderId: kissan.id,
          items: [item({ commodityId: wheat.id })],
        }).expect(400);
        expect(res.body.errors).toEqual([
          { field: 'traderId', message: 'Kissan not found' },
          { field: 'items.0.commodityId', message: 'Commodity not found' },
        ]);
        await expectNothingSaved();
      });

      it('a date in the future', async () => {
        const res = await save({ purchaseDate: '2999-01-01' }).expect(400);
        expect(res.body.errors[0].field).toBe('purchaseDate');
        await expectNothingSaved();
      });

      it('paid more than the net', async () => {
        // No charges in this shop: net 100,000.
        const res = await save({ paidAmount: '100000.01' }).expect(400);
        expect(res.body.errors[0].field).toBe('paidAmount');
        await expectNothingSaved();
      });

      it('a per-bag rate without bags, names the item field', async () => {
        const res = await save({
          items: [
            item({ commodityId: s.wheat.id, rateUnit: 'bag', bags: null }),
          ],
        }).expect(400);
        expect(res.body.errors[0].field).toBe('items.0.bags');
        await expectNothingSaved();
      });

      it('totals or a bill number from the client', async () => {
        await save({ netAmount: '1' }).expect(400);
        await save({ billNo: 'X-1' }).expect(400);
        await expectNothingSaved();
      });

      it('without an Idempotency-Key', async () => {
        const res = await create(
          { traderId: s.kissan.id, items: [item({ commodityId: s.wheat.id })] },
          s.token,
          null,
        ).expect(400);
        expect(res.body.errors).toEqual([
          {
            field: 'Idempotency-Key',
            message: 'Send an Idempotency-Key header',
          },
        ]);
        await expectNothingSaved();
      });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('idempotency (double-click Save)', () => {
    it('the same key again returns the same purchase (200), only one saved', async () => {
      const key = randomUUID();
      const first = await create({}, tokens.operator, key).expect(201);
      const again = await create({}, tokens.operator, key).expect(200);

      expect(again.body).toEqual(first.body);
      const rows = await fx.db
        .select()
        .from(purchases)
        .where(
          and(eq(purchases.tenantId, shopA), eq(purchases.idempotencyKey, key)),
        );
      expect(rows).toHaveLength(1);
      expect(await entriesOf(rows[0].id)).toHaveLength(1);
    });

    it('two clicks at the same moment: one purchase, one bill number', async () => {
      const s = await freshShop();
      const key = randomUUID();
      const body = {
        traderId: s.kissan.id,
        items: [item({ commodityId: s.wheat.id })],
      };

      const results = await Promise.all(
        Array.from({ length: 4 }, () => create(body, s.token, key)),
      );

      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
      expect(new Set(results.map((r) => (r.body as Purchase).id)).size).toBe(1);
      expect(await purchasesIn(s.shop)).toBe(1);
      // The losing saves rolled back their numbers: the next bill is 2.
      const next = await create(body, s.token).expect(201);
      expect(next.body.billNo).toBe(bill(2));
    });

    it('a key is per shop: shop B may use the same key', async () => {
      const key = randomUUID();
      await create({}, tokens.ownerA, key).expect(201);
      const b = await freshShop();
      const res = await create(
        { traderId: b.kissan.id, items: [item({ commodityId: b.wheat.id })] },
        b.token,
        key,
      ).expect(201);
      expect(res.body.trader.id).toBe(b.kissan.id);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('transaction (integration)', () => {
    it('a failure halfway (khata write) saves nothing: no purchase, items or number', async () => {
      const s = await freshShop();
      const body = {
        traderId: s.kissan.id,
        items: [item({ commodityId: s.wheat.id })],
      };
      const ledger = app.get(LedgerService);
      const spy = jest
        .spyOn(ledger, 'post')
        .mockRejectedValueOnce(new Error('connection lost'));
      const quiet = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      try {
        await create(body, s.token).expect(500);
      } finally {
        spy.mockRestore();
        quiet.mockRestore();
      }

      expect(await purchasesIn(s.shop)).toBe(0);
      expect(
        await fx.db
          .select()
          .from(purchaseItems)
          .where(eq(purchaseItems.tenantId, s.shop)),
      ).toEqual([]);
      expect(await balance(s.kissan.id, s.token)).toBe('0.00');
      // No gap: the next save takes number 1.
      const next = await create(body, s.token).expect(201);
      expect(next.body.billNo).toBe(bill(1));
    });

    it('a failure in an edit keeps the old purchase and khata', async () => {
      const p = await created();
      const ledger = app.get(LedgerService);
      const spy = jest
        .spyOn(ledger, 'post')
        .mockRejectedValueOnce(new Error('connection lost'));
      const quiet = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      try {
        await patch(p.id, { items: [item({ weightKg: '2000' })] }).expect(500);
      } finally {
        spy.mockRestore();
        quiet.mockRestore();
      }

      expect((await get(p.id).expect(200)).body).toEqual(p);
      expect(await entriesOf(p.id)).toHaveLength(1);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('concurrency', () => {
    it('operators saving at the same time get different, consecutive bill numbers', async () => {
      const s = await freshShop();
      const operator = await fx.user('operator', s.shop);
      const opToken = await login(operator.phone);
      const body = {
        traderId: s.kissan.id,
        items: [item({ commodityId: s.wheat.id })],
      };

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          create(body, i % 2 ? opToken : s.token),
        ),
      );

      expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
      const numbers = results.map((r) => r.body.billNo as string).sort();
      expect(numbers).toEqual(Array.from({ length: 8 }, (_, i) => bill(i + 1)));
      expect(await balance(s.kissan.id, s.token)).toBe('-800000.00');
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /purchases', () => {
    let s: Awaited<ReturnType<typeof freshShop>>;
    let other: Trader;
    let rice: Commodity;
    const ids = {} as Record<'old' | 'rice' | 'cancelled' | 'today', string>;

    beforeAll(async () => {
      s = await freshShop();
      other = await trader({ name: 'Rashid Khan' }, s.token);
      rice = await commodity(
        { name: `Chawal ${randomUUID().slice(0, 6)}` },
        s.token,
      );
      const save = async (body: Record<string, unknown>) =>
        (
          await create(
            {
              traderId: s.kissan.id,
              items: [item({ commodityId: s.wheat.id })],
              ...body,
            },
            s.token,
          ).expect(201)
        ).body as Purchase;

      ids.old = (await save({ purchaseDate: EARLIER })).id;
      ids.rice = (
        await save({
          traderId: other.id,
          items: [
            item({ commodityId: s.wheat.id }),
            item({ commodityId: rice.id }),
          ],
        })
      ).id;
      ids.cancelled = (await save({})).id;
      await cancel(ids.cancelled, s.token).expect(200);
      ids.today = (await save({})).id;
    });

    const idsOf = (res: request.Response) =>
      (res.body.data as PurchaseSummary[]).map((p) => p.id);

    it('newest first, with paging meta', async () => {
      const res = await list({}, s.token).expect(200);
      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 4 });
      expect(idsOf(res)).toEqual([ids.today, ids.cancelled, ids.rice, ids.old]);
      expect(res.body.data[0]).toEqual({
        id: ids.today,
        billNo: bill(4),
        purchaseDate: TODAY,
        trader: { id: s.kissan.id, name: s.kissan.name },
        grossAmount: '100000.00',
        totalDeductions: '0.00',
        rounding: '0.00',
        netAmount: '100000.00',
        paidAmount: '0.00',
        outstanding: '100000.00',
        status: 'posted',
        notes: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      const page2 = await list({ limit: 3, page: 2 }, s.token).expect(200);
      expect(idsOf(page2)).toEqual([ids.old]);
    });

    it('date range (inclusive)', async () => {
      expect(
        idsOf(await list({ from: EARLIER, to: EARLIER }, s.token).expect(200)),
      ).toEqual([ids.old]);
      expect(
        idsOf(await list({ from: TODAY }, s.token).expect(200)),
      ).not.toContain(ids.old);
    });

    it('by trader, commodity and status', async () => {
      expect(idsOf(await list({ trader: other.id }, s.token))).toEqual([
        ids.rice,
      ]);
      expect(idsOf(await list({ commodity: rice.id }, s.token))).toEqual([
        ids.rice,
      ]);
      expect(idsOf(await list({ status: 'cancelled' }, s.token))).toEqual([
        ids.cancelled,
      ]);
      expect(
        idsOf(await list({ status: 'posted', trader: s.kissan.id }, s.token)),
      ).toEqual([ids.today, ids.old]);
    });

    it('search by bill number or kissan name; sort by bill number', async () => {
      expect(idsOf(await list({ search: bill(2) }, s.token))).toEqual([
        ids.rice,
      ]);
      expect(idsOf(await list({ search: 'rashid' }, s.token))).toEqual([
        ids.rice,
      ]);
      expect(idsOf(await list({ sort: 'billNo' }, s.token))).toEqual([
        ids.old,
        ids.rice,
        ids.cancelled,
        ids.today,
      ]);
    });

    it('400 for a bad filter', async () => {
      await list({ status: 'deleted' }, s.token).expect(400);
      await list({ from: '2026-11-06', to: '2026-11-01' }, s.token).expect(400);
      await list({ commodity: 'rice' }, s.token).expect(400);
    });

    it('every role of the shop can read', async () => {
      const operator = await fx.user('operator', s.shop);
      const opToken = await login(operator.phone);
      await list({}, opToken).expect(200);
      await get(ids.today, opToken).expect(200);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /purchases/:id', () => {
    it('400 for an id that is not a uuid, 404 for an unknown one', async () => {
      await get('not-a-uuid').expect(400);
      await get(UNKNOWN_ID).expect(404);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('PATCH /purchases/:id', () => {
    it('edit weight: totals and khata corrected, audit shows the old values', async () => {
      const k = await trader();
      const p = await created({ traderId: k.id });

      const res = await patch(
        p.id,
        { items: [item({ weightKg: '1200' })] },
        tokens.manager,
      ).expect(200);
      const edited = res.body as Purchase;

      expect(edited).toMatchObject({
        id: p.id,
        billNo: p.billNo,
        grossAmount: '120000.00',
        totalDeductions: '3200.00',
        netAmount: '116800.00',
      });
      expect(edited.items).toEqual([
        expect.objectContaining({ weightKg: '1200.000', amount: '120000.00' }),
      ]);
      expect(await balance(k.id)).toBe('-116800.00');
      // Append-only: the old line, its reversal, the new line.
      expect(
        (await entriesOf(p.id)).map((e) => [e.sourceType, e.debit, e.credit]),
      ).toEqual([
        ['purchase', '0.00', '97300.00'],
        ['reversal', '97300.00', '0.00'],
        ['purchase', '0.00', '116800.00'],
      ]);

      const audit = await fx.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.tenantId, shopA),
            eq(auditLogs.action, 'update'),
            eq(auditLogs.entity, 'purchases'),
            eq(auditLogs.entityId, p.id),
          ),
        );
      expect(audit).toHaveLength(1);
      expect(audit[0].before).toMatchObject({
        grossAmount: '100000.00',
        netAmount: '97300.00',
      });
      expect(audit[0].after).toMatchObject({ netAmount: '116800.00' });
      const oldItem = await fx.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entity, 'purchase_items'),
            eq(auditLogs.entityId, p.items[0].id),
            eq(auditLogs.action, 'delete'),
          ),
        );
      expect(oldItem[0].before).toMatchObject({ weightKg: '1000.000' });
    });

    it('keeps the bill’s own charge rates when the shop changed its settings', async () => {
      const s = await freshShop();
      await fx.db
        .update(tenantSettings)
        .set({ defaultCommissionPct: '2' })
        .where(eq(tenantSettings.tenantId, s.shop));
      const body = {
        traderId: s.kissan.id,
        items: [item({ commodityId: s.wheat.id })],
      };
      const p = (await create(body, s.token).expect(201)).body as Purchase;
      await fx.db
        .update(tenantSettings)
        .set({ defaultCommissionPct: '5' })
        .where(eq(tenantSettings.tenantId, s.shop));

      const kept = await patch(
        p.id,
        { items: [item({ commodityId: s.wheat.id, weightKg: '2000' })] },
        s.token,
      ).expect(200);
      expect(kept.body.charges[0]).toMatchObject({
        type: 'commission',
        value: '2.00',
        amount: '4000.00',
      });

      // null = back to today's default.
      const reset = await patch(
        p.id,
        { charges: { commissionPct: null } },
        s.token,
      ).expect(200);
      expect(reset.body.charges[0]).toMatchObject({
        value: '5.00',
        amount: '10000.00',
      });
      expect(reset.body.items[0].weightKg).toBe('2000.000');
    });

    it('moving the purchase to another kissan moves the credit', async () => {
      const a = await trader();
      const b = await trader();
      const p = await created({ traderId: a.id });

      await patch(p.id, { traderId: b.id }).expect(200);

      expect(await balance(a.id)).toBe('0.00');
      expect(await balance(b.id)).toBe('-97300.00');
    });

    it('paying later on the same bill, and notes without a khata change', async () => {
      const k = await trader();
      const p = await created({ traderId: k.id });

      await patch(p.id, { paidAmount: '50000' }).expect(200);
      expect(await balance(k.id)).toBe('-47300.00');
      const before = (await entriesOf(p.id)).length;

      const res = await patch(p.id, { notes: 'Checked' }).expect(200);
      expect(res.body.notes).toBe('Checked');
      expect(await entriesOf(p.id)).toHaveLength(before);

      await patch(p.id, {}).expect(200);
      await patch(p.id, { paidAmount: '97300.01' }).expect(400);
    });

    it('operator cannot edit (403), not even today', async () => {
      const p = await created({}, tokens.operator);
      await patch(p.id, { notes: 'x' }, tokens.operator).expect(403);
    });

    it('manager: a closed day (before today) → 403 DAY_CLOSED; owner can always edit', async () => {
      const old = await created({ purchaseDate: YESTERDAY });
      const todays = await created();

      const res = await patch(
        old.id,
        { items: [item({ weightKg: '900' })] },
        tokens.manager,
      ).expect(403);
      expect(res.body).toMatchObject({ statusCode: 403, code: 'DAY_CLOSED' });
      await patch(
        todays.id,
        { purchaseDate: YESTERDAY },
        tokens.manager,
      ).expect(403);

      const owner = await patch(
        old.id,
        { items: [item({ weightKg: '900' })] },
        tokens.ownerA,
      ).expect(200);
      expect(owner.body.grossAmount).toBe('90000.00');
      // The correction sits on the purchase's own day.
      expect((await entriesOf(old.id)).map((e) => e.entryDate)).toEqual([
        YESTERDAY,
        YESTERDAY,
        YESTERDAY,
      ]);
    });

    it('400 for an inactive commodity added, but one already on the bill may stay', async () => {
      const c = await commodity();
      const p = await created({ items: [item({ commodityId: c.id })] });
      await as(http().patch(`/commodities/${c.id}`), tokens.ownerA)
        .send({ isActive: false })
        .expect(200);

      await patch(p.id, {
        items: [item({ commodityId: c.id, weightKg: '500' })],
      }).expect(200);
      const off = await commodity({ isActive: false });
      const res = await patch(p.id, {
        items: [item({ commodityId: off.id })],
      }).expect(400);
      expect(res.body.errors[0].field).toBe('items.0.commodityId');
    });

    it('409 for a cancelled purchase; 404 unknown', async () => {
      const p = await created();
      await cancel(p.id).expect(200);
      const res = await patch(p.id, { notes: 'x' }).expect(409);
      expect(res.body.code).toBe('PURCHASE_CANCELLED');
      await patch(UNKNOWN_ID, { notes: 'x' }).expect(404);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('POST /purchases/:id/cancel', () => {
    it('reverses the khata, marks the bill cancelled, the number is not reused', async () => {
      const s = await freshShop();
      const body = {
        traderId: s.kissan.id,
        items: [item({ commodityId: s.wheat.id })],
        paidAmount: '30000',
      };
      const p = (await create(body, s.token).expect(201)).body as Purchase;

      const res = await cancel(p.id, s.token).expect(200);

      expect(res.body).toMatchObject({
        id: p.id,
        billNo: bill(1),
        status: 'cancelled',
        netAmount: '100000.00',
      });
      expect(res.body.items).toHaveLength(1);
      expect(await balance(s.kissan.id, s.token)).toBe('0.00');
      expect((await entriesOf(p.id)).map((e) => e.sourceType)).toEqual([
        'purchase',
        'purchase',
        'reversal',
      ]);
      const next = await create(body, s.token).expect(201);
      expect(next.body.billNo).toBe(bill(2));
      // Still there to read.
      await get(p.id, s.token).expect(200);
    });

    it('twice → 409; nothing more reversed', async () => {
      const p = await created();
      await cancel(p.id).expect(200);
      const res = await cancel(p.id).expect(409);
      expect(res.body.code).toBe('PURCHASE_CANCELLED');
      expect(await entriesOf(p.id)).toHaveLength(2);
    });

    it('only the owner can cancel (manager, operator → 403)', async () => {
      const p = await created();
      await cancel(p.id, tokens.manager).expect(403);
      await cancel(p.id, tokens.operator).expect(403);
      expect((await get(p.id).expect(200)).body.status).toBe('posted');
    });

    it('404 for an unknown id', async () => {
      await cancel(UNKNOWN_ID).expect(404);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('a commodity on a purchase cannot be deleted', () => {
    it('409 COMMODITY_IN_USE', async () => {
      const c = await commodity();
      await created({ items: [item({ commodityId: c.id })] });
      const res = await as(
        http().delete(`/commodities/${c.id}`),
        tokens.ownerA,
      ).expect(409);
      expect(res.body.code).toBe('COMMODITY_IN_USE');
    });
  });

  /* ---------------------------------------------------------------- */
  describe('reconciliation: purchase totals equal the khata', () => {
    it('passes after creates, payments, edits and cancels', async () => {
      const s = await freshShop();
      const k2 = await trader({}, s.token);
      const body = {
        traderId: s.kissan.id,
        items: [item({ commodityId: s.wheat.id })],
      };
      const a = (await create(body, s.token).expect(201)).body as Purchase;
      const b = (
        await create({ ...body, paidAmount: '1000' }, s.token).expect(201)
      ).body as Purchase;
      const c = (await create(body, s.token).expect(201)).body as Purchase;
      await patch(
        a.id,
        { items: [item({ commodityId: s.wheat.id, weightKg: '1500' })] },
        s.token,
      ).expect(200);
      await patch(
        b.id,
        { traderId: k2.id, paidAmount: '2000' },
        s.token,
      ).expect(200);
      await cancel(c.id, s.token).expect(200);

      const result = await app.get(LedgerReconciliation).run([s.shop]);

      expect(result.mismatches).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it('alerts when a purchase and its khata differ', async () => {
      const s = await freshShop();
      const p = (
        await create(
          { traderId: s.kissan.id, items: [item({ commodityId: s.wheat.id })] },
          s.token,
        ).expect(201)
      ).body as Purchase;
      // Changed around the service, as the table owner.
      await fx.db
        .update(purchases)
        .set({ netAmount: '99999.00' })
        .where(eq(purchases.id, p.id));
      const alert = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      try {
        const result = await app.get(LedgerReconciliation).run([s.shop]);
        expect(result.mismatches).toEqual([
          {
            check: 'document',
            tenantId: s.shop,
            traderId: s.kissan.id,
            sourceType: 'purchase',
            sourceId: p.id,
            entryDate: null,
            expected: '-99999.00',
            actual: '-100000.00',
          },
        ]);
      } finally {
        alert.mockRestore();
      }
    });
  });

  /* ---------------------------------------------------------------- */
  describe('multi-tenant isolation', () => {
    let p: Purchase;

    beforeAll(async () => {
      p = await created({ paidAmount: '100' });
    });

    it('shop B’s list never has shop A’s purchases', async () => {
      const res = await list({}, tokens.ownerB).expect(200);
      expect(res.body.data.map((x: PurchaseSummary) => x.id)).not.toContain(
        p.id,
      );
      const filtered = await list({ trader: kissan.id }, tokens.ownerB).expect(
        200,
      );
      expect(filtered.body.meta.total).toBe(0);
    });

    it('shop B cannot read, edit or cancel shop A’s purchase (404, not 403)', async () => {
      await get(p.id, tokens.ownerB).expect(404);
      await patch(p.id, { notes: 'hacked' }, tokens.ownerB).expect(404);
      await cancel(p.id, tokens.ownerB).expect(404);

      const after = await get(p.id).expect(200);
      expect(after.body).toEqual(p);
      expect(await entriesOf(p.id)).toHaveLength(2);
    });

    it('shop B cannot buy from shop A’s kissan, or replay shop A’s key', async () => {
      const key = randomUUID();
      await create({}, tokens.ownerA, key).expect(201);
      const res = await create({}, tokens.ownerB, key).expect(400);
      expect(res.body.errors[0]).toEqual({
        field: 'traderId',
        message: 'Kissan not found',
      });
    });

    it('row-level security: shop B’s role sees no shop A rows even by raw query', async () => {
      const seen = await fx.db.transaction(async (tx) => {
        await tx.execute(sql`set local role app_tenant`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${shopB}, true)`,
        );
        const r = await tx.execute(
          sql`select (select count(*) from purchases where id = ${p.id})::int as p,
                     (select count(*) from purchase_items where purchase_id = ${p.id})::int as i,
                     (select count(*) from purchase_charges where purchase_id = ${p.id})::int as c`,
        );
        return r.rows[0];
      });
      expect(seen).toEqual({ p: 0, i: 0, c: 0 });
    });
  });
});
