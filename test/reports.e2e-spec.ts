import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import Decimal from 'decimal.js';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import { and, eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  ledgerEntries,
  purchases,
  sales,
  tenantSettings,
} from '../src/database/schema';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import type { Commodity } from '../src/modules/commodities/commodities.dto';
import { LedgerReconciliation } from '../src/modules/ledger/ledger-reconciliation.service';
import type { Purchase } from '../src/modules/purchases/purchases.dto';
import type {
  CommissionReport,
  DailySummary,
  OutstandingReport,
  PurchasesReport,
  SalesReport,
} from '../src/modules/reports/reports.dto';
import type { Sale } from '../src/modules/sales/sales.dto';
import type { Trader } from '../src/modules/traders/traders.dto';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';

/*
 * The seeded dataset. The shop charges commission 2%, market fee 1% and
 * labour Rs 10 a bag, on purchases (deducted) and sales (added). D1 is the
 * last day of financial year 2025-26 and D2 the first of 2026-27.
 *
 *   P1 D1 kissan K1  wheat 1000 kg → edited to 1200 kg, 12 bags @ 4000/mn
 *                    gross 120,000 − (2,400 + 1,200 + 120) = net 116,280
 *   P2 D1 kissan K2  wheat 400 kg, 4 bags @ 4000/mn  = 40,000
 *                    rice  200 kg, 5 bags @ 150.55/kg = 30,110
 *                    gross 70,110 − (1,402.20 + 701.10 + 90) = 67,916.70
 *                    → net 67,917 (rounded), 10,000 paid on the bill
 *   P3 D2 kissan K1  rice 1000 kg, 20 bags @ 6000/mn
 *                    gross 150,000 − (3,000 + 1,500 + 200) = net 145,300
 *   P4 D2 kissan K2  wheat 500 kg, 5 bags: cancelled
 *   S1 D1 beopari B1 wheat 1000 kg, 10 bags @ 4100/mn
 *                    gross 102,500 + (2,050 + 1,025 + 100) = net 105,675,
 *                    5,000 received on the bill
 *   S2 D2 beopari B2 rice 800 kg, 16 bags @ 6100/mn
 *                    gross 122,000 + (2,440 + 1,220 + 160) = net 125,820
 *   S3 D2 beopari B1 wheat 100 kg, 1 bag: cancelled
 *   PAY1 D1 cash paid K1 30,000      PAY2 D2 bank paid K2 20,000
 *   RCT1 D2 cash from B1 50,000      RCT2 D2 cash from B2 25,000: cancelled
 */
const D0 = '2026-06-29';
const D1 = '2026-06-30';
const D2 = '2026-07-01';

type Token = 'ownerA' | 'ownerB' | 'manager' | 'operator' | 'superAdmin';

describe('Reports /reports (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;
  let shopA: string;
  let shopB: string;
  const tokens = {} as Record<Token, string>;
  const A = {} as {
    K1: Trader;
    K2: Trader;
    B1: Trader;
    B2: Trader;
    wheat: Commodity;
    rice: Commodity;
    bills: Record<'P1' | 'P2' | 'P3' | 'P4', Purchase>;
    sales: Record<'S1' | 'S2' | 'S3', Sale>;
  };
  let traderB: Trader;

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string | null) =>
    token ? req.set('Authorization', `Bearer ${token}`) : req;

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

  const post = (token: string, path: string, body: object) =>
    as(http().post(path), token)
      .set('Idempotency-Key', randomUUID())
      .send(body);

  async function trader(token: string, type: string, name: string) {
    const res = await as(http().post('/traders'), token)
      .send({ type, name: `${name} ${randomUUID().slice(0, 6)}` })
      .expect(201);
    return res.body as Trader;
  }

  async function commodity(token: string, name: string) {
    const res = await as(http().post('/commodities'), token)
      .send({ name: `${name} ${randomUUID().slice(0, 6)}` })
      .expect(201);
    return res.body as Commodity;
  }

  const line = (
    c: Commodity,
    weightKg: string,
    bags: number,
    rate: string,
    rateUnit = 'maund',
  ) => ({ commodityId: c.id, weightKg, bags, rate, rateUnit });

  async function buy(token: string, body: object): Promise<Purchase> {
    return (await post(token, '/purchases', body).expect(201)).body as Purchase;
  }
  async function sell(token: string, body: object): Promise<Sale> {
    return (await post(token, '/sales', body).expect(201)).body as Sale;
  }
  async function pay(token: string, body: object): Promise<{ id: string }> {
    return (await post(token, '/payments', body).expect(201)).body as {
      id: string;
    };
  }

  const report = (
    path: string,
    query: Record<string, unknown> = {},
    token: string | null = tokens.ownerA,
  ) => as(http().get(`/reports/${path}`), token).query(query);

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
    const charges = {
      defaultCommissionPct: '2',
      marketFeePct: '1',
      labourPerBag: '10',
    };
    await fx.db.insert(tenantSettings).values([
      { tenantId: shopA, ...charges },
      { tenantId: shopB, ...charges },
    ]);
    tokens.ownerA = await login((await fx.user('owner', shopA)).phone);
    tokens.ownerB = await login((await fx.user('owner', shopB)).phone);
    tokens.manager = await login((await fx.user('manager', shopA)).phone);
    tokens.operator = await login((await fx.user('operator', shopA)).phone);
    tokens.superAdmin = await login((await fx.user('super_admin', null)).phone);

    const t = tokens.ownerA;
    A.K1 = await trader(t, 'kissan', 'Akram');
    A.K2 = await trader(t, 'kissan', 'Bashir');
    A.B1 = await trader(t, 'beopari', 'Chaudhry');
    A.B2 = await trader(t, 'beopari', 'Dilawar');
    // "Chawal" sorts before "Gandum".
    A.rice = await commodity(t, 'Chawal');
    A.wheat = await commodity(t, 'Gandum');

    const P1 = await buy(t, {
      traderId: A.K1.id,
      purchaseDate: D1,
      items: [line(A.wheat, '1000', 10, '4000')],
    });
    // The weight was wrong: the old lines are soft-deleted and must not count.
    const edited = await as(http().patch(`/purchases/${P1.id}`), t)
      .send({ items: [line(A.wheat, '1200', 12, '4000')] })
      .expect(200);
    const P2 = await buy(t, {
      traderId: A.K2.id,
      purchaseDate: D1,
      items: [
        line(A.wheat, '400', 4, '4000'),
        line(A.rice, '200', 5, '150.55', 'kg'),
      ],
      paidAmount: '10000',
    });
    const P3 = await buy(t, {
      traderId: A.K1.id,
      purchaseDate: D2,
      items: [line(A.rice, '1000', 20, '6000')],
    });
    const P4 = await buy(t, {
      traderId: A.K2.id,
      purchaseDate: D2,
      items: [line(A.wheat, '500', 5, '4000')],
    });
    await as(http().post(`/purchases/${P4.id}/cancel`), t).expect(200);
    A.bills = { P1: edited.body as Purchase, P2, P3, P4 };

    const S1 = await sell(t, {
      buyerId: A.B1.id,
      saleDate: D1,
      items: [line(A.wheat, '1000', 10, '4100')],
      receivedAmount: '5000',
    });
    const S2 = await sell(t, {
      buyerId: A.B2.id,
      saleDate: D2,
      items: [line(A.rice, '800', 16, '6100')],
    });
    const S3 = await sell(t, {
      buyerId: A.B1.id,
      saleDate: D2,
      items: [line(A.wheat, '100', 1, '4100')],
    });
    await as(http().post(`/sales/${S3.id}/cancel`), t).expect(200);
    A.sales = { S1, S2, S3 };

    const cash = (direction: string, traderId: string, d: string) => ({
      direction,
      traderId,
      paymentDate: d,
      method: 'cash',
    });
    await pay(t, { ...cash('paid', A.K1.id, D1), amount: '30000' });
    await pay(t, {
      ...cash('paid', A.K2.id, D2),
      method: 'bank',
      amount: '20000',
    });
    await pay(t, { ...cash('received', A.B1.id, D2), amount: '50000' });
    const RCT2 = await pay(t, {
      ...cash('received', A.B2.id, D2),
      amount: '25000',
    });
    await as(http().post(`/payments/${RCT2.id}/cancel`), t).expect(200);

    await as(http().put(`/rates/${D2}`), t)
      .send({
        rates: [{ commodityId: A.wheat.id, minRate: '3900', maxRate: '4100' }],
      })
      .expect(200);

    // Shop B trades on the same days, with bigger numbers and the same names.
    const tb = tokens.ownerB;
    traderB = await trader(tb, 'kissan', 'Akram');
    const beopariB = await trader(tb, 'beopari', 'Chaudhry');
    const wheatB = await commodity(tb, 'Gandum');
    for (const d of [D1, D2]) {
      await buy(tb, {
        traderId: traderB.id,
        purchaseDate: d,
        items: [line(wheatB, '9000', 90, '4000')],
      });
      await sell(tb, {
        buyerId: beopariB.id,
        saleDate: d,
        items: [line(wheatB, '9000', 90, '4100')],
      });
      await pay(tb, {
        direction: 'received',
        traderId: beopariB.id,
        paymentDate: d,
        method: 'cash',
        amount: '99999',
      });
    }
  }, 120_000);

  beforeEach(() => resetThrottle());

  afterAll(async () => {
    await app.close();
    await fx.cleanup();
  });

  /* ---------------------------------------------------------------- */
  describe('seeded dataset: the expected totals', () => {
    it('the bills are what the dataset says (numbers from two financial years)', () => {
      expect(A.bills.P1).toMatchObject({
        grossAmount: '120000.00',
        totalDeductions: '3720.00',
        netAmount: '116280.00',
      });
      expect(A.bills.P2).toMatchObject({
        grossAmount: '70110.00',
        totalDeductions: '2193.30',
        netAmount: '67917.00',
      });
      expect(A.bills.P1.billNo).toContain('-2025-26-');
      expect(A.bills.P3.billNo).toContain('-2026-27-');
      expect(A.sales.S1).toMatchObject({ netAmount: '105675.00' });
      expect(A.sales.S2).toMatchObject({ netAmount: '125820.00' });
    });

    it('daily summary of D2: posted documents only, cancelled ones counted apart', async () => {
      const res = await report('daily-summary', { date: D2 }).expect(200);
      const body = res.body as DailySummary;
      expect(body).toEqual({
        date: D2,
        purchases: {
          bills: 1,
          bags: 20,
          weightKg: '1000.000',
          grossAmount: '150000.00',
          totalDeductions: '4700.00',
          netAmount: '145300.00',
          paidOnBills: '0.00',
        },
        sales: {
          bills: 1,
          bags: 16,
          weightKg: '800.000',
          grossAmount: '122000.00',
          totalCharges: '3820.00',
          netAmount: '125820.00',
          receivedOnBills: '0.00',
        },
        commission: {
          purchases: '3000.00',
          sales: '2440.00',
          total: '5440.00',
        },
        payments: {
          paid: { count: 1, amount: '20000.00' },
          received: { count: 1, amount: '50000.00' },
        },
        cash: {
          openingCash: '-30000.00',
          cashIn: '50000.00',
          cashOut: '0.00',
          closingCash: '20000.00',
        },
        cancelled: { purchases: 1, sales: 1, payments: 1 },
        rates: [
          expect.objectContaining({
            commodityId: A.wheat.id,
            rateDate: D2,
            minRate: '3900.00',
            maxRate: '4100.00',
          }),
        ],
      });
    });

    it("daily total purchases = the sum of that day's posted purchases", async () => {
      const body = (await report('daily-summary', { date: D1 }).expect(200))
        .body as DailySummary;
      const [docs] = await fx.db
        .select({
          bills: sql<number>`count(*)::int`,
          net: sql<string>`sum(${purchases.netAmount})::text`,
          gross: sql<string>`sum(${purchases.grossAmount})::text`,
        })
        .from(purchases)
        .where(
          and(
            eq(purchases.tenantId, shopA),
            eq(purchases.purchaseDate, D1),
            eq(purchases.status, 'posted'),
          ),
        );
      expect(body.purchases).toEqual({
        bills: 2,
        bags: 21,
        weightKg: '1800.000',
        grossAmount: '190110.00',
        totalDeductions: '5913.30',
        netAmount: '184197.00',
        paidOnBills: '10000.00',
      });
      expect(body.purchases.bills).toBe(docs.bills);
      expect(body.purchases.netAmount).toBe(docs.net);
      expect(body.purchases.grossAmount).toBe(docs.gross);
      expect(body.sales).toMatchObject({
        bills: 1,
        netAmount: '105675.00',
        receivedOnBills: '5000.00',
      });
      expect(body.cancelled).toEqual({ purchases: 0, sales: 0, payments: 0 });
      expect(body.rates).toEqual([]);
    });

    it('a day without business is all zeros', async () => {
      const body = (await report('daily-summary', { date: D0 }).expect(200))
        .body as DailySummary;
      expect(body.purchases).toEqual({
        bills: 0,
        bags: 0,
        weightKg: '0.000',
        grossAmount: '0.00',
        totalDeductions: '0.00',
        netAmount: '0.00',
        paidOnBills: '0.00',
      });
      expect(body.cash).toEqual({
        openingCash: '0.00',
        cashIn: '0.00',
        cashOut: '0.00',
        closingCash: '0.00',
      });
    });

    it('purchases by day across the financial year', async () => {
      const body = (await report('purchases', { from: D1, to: D2 }).expect(200))
        .body as PurchasesReport;
      expect(body).toEqual({
        from: D1,
        to: D2,
        groupBy: 'day',
        commodity: null,
        trader: null,
        rows: [
          {
            key: D1,
            label: D1,
            bills: 2,
            bags: 21,
            weightKg: '1800.000',
            grossAmount: '190110.00',
            totalDeductions: '5913.30',
            netAmount: '184197.00',
          },
          {
            key: D2,
            label: D2,
            bills: 1,
            bags: 20,
            weightKg: '1000.000',
            grossAmount: '150000.00',
            totalDeductions: '4700.00',
            netAmount: '145300.00',
          },
        ],
        totals: {
          bills: 3,
          bags: 41,
          weightKg: '2800.000',
          grossAmount: '340110.00',
          totalDeductions: '10613.30',
          netAmount: '329497.00',
        },
      });
    });

    it('purchases by commodity: item lines, no bill-level split', async () => {
      const body = (
        await report('purchases', {
          from: D1,
          to: D2,
          groupBy: 'commodity',
        }).expect(200)
      ).body as PurchasesReport;
      expect(body.rows).toEqual([
        {
          key: A.rice.id,
          label: A.rice.name,
          bills: 2,
          bags: 25,
          weightKg: '1200.000',
          grossAmount: '180110.00',
          totalDeductions: null,
          netAmount: null,
        },
        {
          key: A.wheat.id,
          label: A.wheat.name,
          bills: 2,
          bags: 16,
          weightKg: '1600.000',
          grossAmount: '160000.00',
          totalDeductions: null,
          netAmount: null,
        },
      ]);
      // P2 has both commodities: counted once in the totals.
      expect(body.totals).toEqual({
        bills: 3,
        bags: 41,
        weightKg: '2800.000',
        grossAmount: '340110.00',
        totalDeductions: '10613.30',
        netAmount: '329497.00',
      });
    });

    it('purchases by trader', async () => {
      const body = (
        await report('purchases', {
          from: D1,
          to: D2,
          groupBy: 'trader',
        }).expect(200)
      ).body as PurchasesReport;
      expect(body.rows).toEqual([
        {
          key: A.K1.id,
          label: A.K1.name,
          bills: 2,
          bags: 32,
          weightKg: '2200.000',
          grossAmount: '270000.00',
          totalDeductions: '8420.00',
          netAmount: '261580.00',
        },
        {
          key: A.K2.id,
          label: A.K2.name,
          bills: 1,
          bags: 9,
          weightKg: '600.000',
          grossAmount: '70110.00',
          totalDeductions: '2193.30',
          netAmount: '67917.00',
        },
      ]);
    });

    it('sales by day, commodity and trader', async () => {
      const byDay = (await report('sales', { from: D1, to: D2 }).expect(200))
        .body as SalesReport;
      expect(byDay.rows).toEqual([
        {
          key: D1,
          label: D1,
          bills: 1,
          bags: 10,
          weightKg: '1000.000',
          grossAmount: '102500.00',
          totalCharges: '3175.00',
          netAmount: '105675.00',
        },
        {
          key: D2,
          label: D2,
          bills: 1,
          bags: 16,
          weightKg: '800.000',
          grossAmount: '122000.00',
          totalCharges: '3820.00',
          netAmount: '125820.00',
        },
      ]);
      expect(byDay.totals).toEqual({
        bills: 2,
        bags: 26,
        weightKg: '1800.000',
        grossAmount: '224500.00',
        totalCharges: '6995.00',
        netAmount: '231495.00',
      });

      const byCommodity = (
        await report('sales', {
          from: D1,
          to: D2,
          groupBy: 'commodity',
        }).expect(200)
      ).body as SalesReport;
      expect(
        byCommodity.rows.map((r) => [r.label, r.weightKg, r.grossAmount]),
      ).toEqual([
        [A.rice.name, '800.000', '122000.00'],
        [A.wheat.name, '1000.000', '102500.00'],
      ]);

      const byTrader = (
        await report('sales', { from: D1, to: D2, groupBy: 'trader' }).expect(
          200,
        )
      ).body as SalesReport;
      expect(byTrader.rows.map((r) => [r.key, r.netAmount])).toEqual([
        [A.B1.id, '105675.00'],
        [A.B2.id, '125820.00'],
      ]);
    });

    it('commission earned, with market fee and labour kept apart', async () => {
      const body = (
        await report('commission', { from: D1, to: D2 }).expect(200)
      ).body as CommissionReport;
      expect(body).toEqual({
        from: D1,
        to: D2,
        days: [
          {
            date: D1,
            purchases: '3802.20',
            sales: '2050.00',
            total: '5852.20',
          },
          {
            date: D2,
            purchases: '3000.00',
            sales: '2440.00',
            total: '5440.00',
          },
        ],
        totals: { purchases: '6802.20', sales: '4490.00', total: '11292.20' },
        otherCharges: {
          marketFee: {
            purchases: '3401.10',
            sales: '2245.00',
            total: '5646.10',
          },
          labour: { purchases: '410.00', sales: '260.00', total: '670.00' },
          other: { purchases: '0.00', sales: '0.00', total: '0.00' },
        },
      });
    });

    it('commission + market fee + labour = the deductions and charges of the bills', async () => {
      const [c, p, s] = await Promise.all([
        report('commission', { from: D1, to: D2 }).expect(200),
        report('purchases', { from: D1, to: D2 }).expect(200),
        report('sales', { from: D1, to: D2 }).expect(200),
      ]);
      const comm = c.body as CommissionReport;
      const sum = (side: 'purchases' | 'sales') =>
        new Decimal(comm.totals[side])
          .plus(comm.otherCharges.marketFee[side])
          .plus(comm.otherCharges.labour[side])
          .plus(comm.otherCharges.other[side])
          .toFixed(2);
      expect(sum('purchases')).toBe(
        (p.body as PurchasesReport).totals.totalDeductions,
      );
      expect(sum('sales')).toBe((s.body as SalesReport).totals.totalCharges);
    });

    it('outstanding now: receivable and payable from the khata', async () => {
      const body = (await report('outstanding').expect(200))
        .body as OutstandingReport;
      const row = (t: Trader, amount: string) => ({
        traderId: t.id,
        type: t.type,
        name: t.name,
        phone: null,
        amount,
      });
      expect(body).toEqual({
        asOf: null,
        receivable: {
          total: '176495.00',
          count: 2,
          traders: [row(A.B2, '125820.00'), row(A.B1, '50675.00')],
        },
        payable: {
          total: '269497.00',
          count: 2,
          traders: [row(A.K1, '231580.00'), row(A.K2, '37917.00')],
        },
      });
    });

    it('outstanding as of D1, by type and with a limit', async () => {
      const asOf = (await report('outstanding', { asOf: D1 }).expect(200))
        .body as OutstandingReport;
      expect(asOf.receivable).toMatchObject({ total: '100675.00', count: 1 });
      expect(asOf.payable).toMatchObject({ total: '144197.00', count: 2 });

      const kissans = (
        await report('outstanding', { type: 'kissan', limit: 1 }).expect(200)
      ).body as OutstandingReport;
      expect(kissans.receivable).toEqual({
        total: '0.00',
        count: 0,
        traders: [],
      });
      expect(kissans.payable.total).toBe('269497.00');
      expect(kissans.payable.count).toBe(2);
      expect(kissans.payable.traders.map((t) => t.traderId)).toEqual([A.K1.id]);
    });

    it('cash book: the payments cash book over the range', async () => {
      const [rep, pay] = await Promise.all([
        report('cash-book', { from: D1, to: D2 }).expect(200),
        as(http().get('/payments/cash-book'), tokens.ownerA)
          .query({ from: D1, to: D2 })
          .expect(200),
      ]);
      expect(rep.body).toEqual({
        from: D1,
        to: D2,
        openingCash: '0.00',
        days: [
          {
            date: D1,
            cashIn: '0.00',
            cashOut: '30000.00',
            closingCash: '-30000.00',
          },
          {
            date: D2,
            cashIn: '50000.00',
            cashOut: '0.00',
            closingCash: '20000.00',
          },
        ],
        totals: { cashIn: '50000.00', cashOut: '30000.00' },
        closingCash: '20000.00',
      });
      expect(rep.body).toEqual(pay.body);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('totals match the ledger and the documents', () => {
    it('outstanding totals = GET /ledger/balances totals', async () => {
      const [rep, ledger] = await Promise.all([
        report('outstanding').expect(200),
        as(http().get('/ledger/balances'), tokens.ownerA).expect(200),
      ]);
      const body = rep.body as OutstandingReport;
      expect(ledger.body.totals).toEqual({
        receivable: body.receivable.total,
        payable: body.payable.total,
      });
    });

    it("purchases net − paid on bills = the khata effect of the range's bills", async () => {
      const body = (await report('purchases', { from: D1, to: D2 }).expect(200))
        .body as PurchasesReport;
      const ids = Object.values(A.bills).map((b) => b.id);
      const [{ effect }] = await fx.db
        .select({
          effect: sql<string>`sum(${ledgerEntries.credit} - ${ledgerEntries.debit})::text`,
        })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.tenantId, shopA),
            inArray(ledgerEntries.sourceId, ids),
          ),
        );
      // 329,497 net − 10,000 paid on P2; P4's entries cancel out.
      expect(body.totals.netAmount).toBe('329497.00');
      expect(effect).toBe('319497.00');
    });

    it("sales net − received on bills = the khata effect of the range's bills", async () => {
      const body = (await report('sales', { from: D1, to: D2 }).expect(200))
        .body as SalesReport;
      const ids = Object.values(A.sales).map((b) => b.id);
      const [{ effect }] = await fx.db
        .select({
          effect: sql<string>`sum(${ledgerEntries.debit} - ${ledgerEntries.credit})::text`,
        })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.tenantId, shopA),
            inArray(ledgerEntries.sourceId, ids),
          ),
        );
      expect(body.totals.netAmount).toBe('231495.00');
      expect(effect).toBe('226495.00');
      const [docs] = await fx.db
        .select({ net: sql<string>`sum(${sales.netAmount})::text` })
        .from(sales)
        .where(and(eq(sales.tenantId, shopA), eq(sales.status, 'posted')));
      expect(docs.net).toBe(body.totals.netAmount);
    });

    it('the reconciliation passes for the dataset', async () => {
      const result = await app.get(LedgerReconciliation).run([shopA]);
      expect(result).toMatchObject({ ok: true, mismatches: [] });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('filters and date ranges', () => {
    it('one day of a range is only that day', async () => {
      const body = (await report('purchases', { from: D2, to: D2 }).expect(200))
        .body as PurchasesReport;
      expect(body.totals.netAmount).toBe('145300.00');
      expect(body.rows.map((r) => r.key)).toEqual([D2]);
    });

    it('no dates means today (nothing was dated today)', async () => {
      const body = (await report('purchases').expect(200))
        .body as PurchasesReport;
      expect(body.from).toBe(body.to);
      expect(body.rows).toEqual([]);
      expect(body.totals).toEqual({
        bills: 0,
        bags: 0,
        weightKg: '0.000',
        grossAmount: '0.00',
        totalDeductions: '0.00',
        netAmount: '0.00',
      });
    });

    it('a commodity filter: only its lines, bill-level fields null', async () => {
      const body = (
        await report('purchases', {
          from: D1,
          to: D2,
          commodity: A.wheat.id,
        }).expect(200)
      ).body as PurchasesReport;
      expect(body.commodity).toBe(A.wheat.id);
      expect(body.rows).toEqual([
        {
          key: D1,
          label: D1,
          bills: 2,
          bags: 16,
          weightKg: '1600.000',
          grossAmount: '160000.00',
          totalDeductions: null,
          netAmount: null,
        },
      ]);
      expect(body.totals).toMatchObject({
        bills: 2,
        grossAmount: '160000.00',
        totalDeductions: null,
        netAmount: null,
      });
    });

    it('a trader filter', async () => {
      const body = (
        await report('purchases', {
          from: D1,
          to: D2,
          trader: A.K2.id,
          groupBy: 'commodity',
        }).expect(200)
      ).body as PurchasesReport;
      expect(body.rows.map((r) => [r.label, r.grossAmount])).toEqual([
        [A.rice.name, '30110.00'],
        [A.wheat.name, '40000.00'],
      ]);
      expect(body.totals).toMatchObject({
        bills: 1,
        netAmount: '67917.00',
      });
      const sold = (
        await report('sales', { from: D1, to: D2, trader: A.B1.id }).expect(200)
      ).body as SalesReport;
      expect(sold.totals.netAmount).toBe('105675.00');
    });

    it('a whole year is allowed; one day more is 400', async () => {
      await report('purchases', {
        from: '2025-07-01',
        to: '2026-06-30',
      }).expect(200);
      for (const path of ['purchases', 'sales', 'commission', 'cash-book']) {
        const res = await report(path, {
          from: '2025-07-01',
          to: '2026-07-02',
        }).expect(400);
        expect(res.body.errors).toEqual([
          { field: 'to', message: 'Choose at most 366 days' },
        ]);
      }
    });

    it('a start after the end, a bad date or a bad group is 400', async () => {
      const after = await report('commission', { from: D2, to: D1 }).expect(
        400,
      );
      expect(after.body.errors[0].field).toBe('from');
      const date = await report('daily-summary', { date: '2026-02-30' }).expect(
        400,
      );
      expect(date.body.errors[0]).toEqual({
        field: 'date',
        message: 'Enter the date as YYYY-MM-DD',
      });
      const group = await report('sales', { groupBy: 'month' }).expect(400);
      expect(group.body.errors[0].field).toBe('groupBy');
      await report('purchases', { commodity: 'wheat' }).expect(400);
      await report('outstanding', { limit: '0' }).expect(400);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('permissions: owner and manager only', () => {
    const PATHS = [
      'daily-summary',
      'purchases',
      'sales',
      'commission',
      'outstanding',
      'cash-book',
    ];

    it.each(PATHS)('operator gets 403 on %s', async (path) => {
      await report(path, {}, tokens.operator).expect(403);
    });

    it.each(PATHS)('manager gets 200 on %s', async (path) => {
      await report(path, { from: D1, to: D2 }, tokens.manager).expect(200);
    });

    it.each(PATHS)('signed out gets 401 on %s', async (path) => {
      await report(path, {}, null).expect(401);
    });

    it.each(PATHS)(
      'the platform admin (no shop) gets 403 on %s',
      async (path) => {
        await report(path, {}, tokens.superAdmin).expect(403);
      },
    );

    it("the manager sees the owner's numbers", async () => {
      const [owner, manager] = await Promise.all([
        report('commission', { from: D1, to: D2 }).expect(200),
        report('commission', { from: D1, to: D2 }, tokens.manager).expect(200),
      ]);
      expect(manager.body).toEqual(owner.body);
    });
  });

  /* ---------------------------------------------------------------- */
  describe("isolation: shop A's reports never include shop B's data", () => {
    it('every report of shop A has only its own totals', async () => {
      const [summary, bought, sold, comm, out, cash] = await Promise.all([
        report('daily-summary', { date: D1 }).expect(200),
        report('purchases', { from: D1, to: D2, groupBy: 'trader' }).expect(
          200,
        ),
        report('sales', { from: D1, to: D2, groupBy: 'commodity' }).expect(200),
        report('commission', { from: D1, to: D2 }).expect(200),
        report('outstanding').expect(200),
        report('cash-book', { from: D1, to: D2 }).expect(200),
      ]);
      expect((summary.body as DailySummary).purchases.netAmount).toBe(
        '184197.00',
      );
      const traderIds = (bought.body as PurchasesReport).rows.map((r) => r.key);
      expect(traderIds.sort()).toEqual([A.K1.id, A.K2.id].sort());
      expect((sold.body as SalesReport).rows.map((r) => r.key).sort()).toEqual(
        [A.rice.id, A.wheat.id].sort(),
      );
      expect((comm.body as CommissionReport).totals.total).toBe('11292.20');
      const outstanding = out.body as OutstandingReport;
      expect(outstanding.receivable.count + outstanding.payable.count).toBe(4);
      expect(
        [...outstanding.receivable.traders, ...outstanding.payable.traders].map(
          (t) => t.traderId,
        ),
      ).not.toContain(traderB.id);
      expect(cash.body.totals).toEqual({
        cashIn: '50000.00',
        cashOut: '30000.00',
      });
    });

    it("a filter on shop B's trader or commodity finds nothing in shop A", async () => {
      const body = (
        await report('purchases', {
          from: D1,
          to: D2,
          trader: traderB.id,
        }).expect(200)
      ).body as PurchasesReport;
      expect(body.rows).toEqual([]);
      expect(body.totals.bills).toBe(0);
    });

    it('a tenant_id in the query is ignored', async () => {
      const body = (
        await report('purchases', {
          from: D1,
          to: D2,
          tenant_id: shopB,
          tenantId: shopB,
        }).expect(200)
      ).body as PurchasesReport;
      expect(body.totals.netAmount).toBe('329497.00');
    });

    it("shop B sees its own numbers, never shop A's", async () => {
      const body = (
        await report('purchases', { from: D1, to: D2 }, tokens.ownerB).expect(
          200,
        )
      ).body as PurchasesReport;
      // 2 × 9,000 kg at Rs 4,000/maund = 1,800,000 gross.
      expect(body.totals).toMatchObject({
        bills: 2,
        weightKg: '18000.000',
        grossAmount: '1800000.00',
      });
      const out = (await report('outstanding', {}, tokens.ownerB).expect(200))
        .body as OutstandingReport;
      const ids = [...out.receivable.traders, ...out.payable.traders].map(
        (t) => t.traderId,
      );
      for (const t of [A.K1, A.K2, A.B1, A.B2]) expect(ids).not.toContain(t.id);
    });
  });
});
