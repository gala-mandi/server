import { randomUUID } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import { asc, count, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { karachiDate, previousDate } from '../src/common/time/karachi-date';
import {
  ledgerEntries,
  paymentAllocations,
  payments,
  tenantSettings,
} from '../src/database/schema';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import type { Commodity } from '../src/modules/commodities/commodities.dto';
import { LedgerReconciliation } from '../src/modules/ledger/ledger-reconciliation.service';
import { financialYear } from '../src/modules/numbering/bill-number';
import type {
  PaymentSummary,
  SavedPayment,
} from '../src/modules/payments/payments.dto';
import type { Purchase } from '../src/modules/purchases/purchases.dto';
import type { Sale } from '../src/modules/sales/sales.dto';
import type { Trader } from '../src/modules/traders/traders.dto';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const TODAY = karachiDate();
const YESTERDAY = previousDate(TODAY);
const EARLIER = previousDate(previousDate(YESTERDAY));
const FY = financialYear(TODAY, null);
const voucher = (prefix: 'PAY' | 'RCT', n: number) =>
  `${prefix}-${FY}-${String(n).padStart(6, '0')}`;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

type Token = 'ownerA' | 'ownerB' | 'manager' | 'operator';

describe('Payments /payments (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;
  let shopA: string;
  let shopB: string;
  const tokens = {} as Record<Token, string>;

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

  async function trader(
    token: string,
    body: Record<string, unknown> = {},
  ): Promise<Trader> {
    const res = await as(http().post('/traders'), token)
      .send({
        type: 'kissan',
        name: `Trader ${randomUUID().slice(0, 8)}`,
        ...body,
      })
      .expect(201);
    return res.body as Trader;
  }

  async function commodity(token: string): Promise<Commodity> {
    const res = await as(http().post('/commodities'), token)
      .send({ name: `Gandum ${randomUUID().slice(0, 8)}` })
      .expect(201);
    return res.body as Commodity;
  }

  /**
   * A new shop (no charges, so 1,000 kg at Rs 4,000/maund is a Rs 100,000
   * bill) with an owner, a kissan, a beopari and wheat.
   */
  async function freshShop(
    settings: { overpaymentAction?: string; billPrefix?: string } = {},
  ) {
    const shop = await fx.tenant();
    await fx.db.insert(tenantSettings).values({ tenantId: shop, ...settings });
    const owner = await fx.user('owner', shop);
    const token = await login(owner.phone);
    return {
      shop,
      token,
      kissan: await trader(token),
      beopari: await trader(token, { type: 'beopari' }),
      wheat: await commodity(token),
    };
  }
  type Shop = Awaited<ReturnType<typeof freshShop>>;

  const item = (s: Shop) => ({
    commodityId: s.wheat.id,
    bags: 10,
    weightKg: '1000',
    rate: '4000',
    rateUnit: 'maund',
  });

  /** A Rs 100,000 purchase from the shop's kissan (or `traderId`). */
  async function buy(
    s: Shop,
    body: Record<string, unknown> = {},
  ): Promise<Purchase> {
    const res = await as(http().post('/purchases'), s.token)
      .set('Idempotency-Key', randomUUID())
      .send({ traderId: s.kissan.id, items: [item(s)], ...body })
      .expect(201);
    return res.body as Purchase;
  }

  /** A Rs 100,000 sale to the shop's beopari. */
  async function sell(
    s: Shop,
    body: Record<string, unknown> = {},
  ): Promise<Sale> {
    const res = await as(http().post('/sales'), s.token)
      .set('Idempotency-Key', randomUUID())
      .send({ buyerId: s.beopari.id, items: [item(s)], ...body })
      .expect(201);
    return res.body as Sale;
  }

  /** POST /payments: by default Rs 40,000 cash paid to the shop's kissan. */
  const pay = (
    s: Shop,
    body: Record<string, unknown> = {},
    key: string | null = randomUUID(),
    token: string | null = s.token,
  ) => {
    const req = as(http().post('/payments'), token);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send({
      direction: 'paid',
      traderId: s.kissan.id,
      amount: '40000',
      method: 'cash',
      ...body,
    });
  };
  const paid = async (s: Shop, body: Record<string, unknown> = {}) =>
    (await pay(s, body).expect(201)).body as SavedPayment;
  const receive = (s: Shop, body: Record<string, unknown> = {}) =>
    pay(s, { direction: 'received', traderId: s.beopari.id, ...body });

  const get = (s: Shop, id: string, token = s.token) =>
    as(http().get(`/payments/${id}`), token);
  const list = (
    s: Shop,
    query: Record<string, unknown> = {},
    token = s.token,
  ) => as(http().get('/payments'), token).query(query);
  const cancel = (s: Shop, id: string, token = s.token) =>
    as(http().post(`/payments/${id}/cancel`), token);
  const cashBook = (
    s: Shop,
    query: Record<string, unknown> = {},
    token = s.token,
  ) => as(http().get('/payments/cash-book'), token).query(query);

  async function purchaseOf(s: Shop, id: string): Promise<Purchase> {
    return (await as(http().get(`/purchases/${id}`), s.token).expect(200))
      .body as Purchase;
  }
  async function saleOf(s: Shop, id: string): Promise<Sale> {
    return (await as(http().get(`/sales/${id}`), s.token).expect(200))
      .body as Sale;
  }

  /** The khata balance (debit − credit) of a trader, via the API. */
  async function balance(s: Shop, traderId: string): Promise<string> {
    const res = await as(http().get(`/ledger/${traderId}`), s.token).expect(
      200,
    );
    return res.body.closingBalance as string;
  }

  const entriesOf = (sourceId: string) =>
    fx.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.sourceId, sourceId))
      .orderBy(asc(ledgerEntries.id));

  const paymentsIn = async (tenantId: string) =>
    (
      await fx.db
        .select({ n: count() })
        .from(payments)
        .where(eq(payments.tenantId, tenantId))
    )[0].n;

  const withoutWarnings = (p: SavedPayment) =>
    Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'warnings'));

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
    await fx.db
      .insert(tenantSettings)
      .values([{ tenantId: shopA }, { tenantId: shopB }]);
    tokens.ownerA = await login((await fx.user('owner', shopA)).phone);
    tokens.ownerB = await login((await fx.user('owner', shopB)).phone);
    tokens.manager = await login((await fx.user('manager', shopA)).phone);
    tokens.operator = await login((await fx.user('operator', shopA)).phone);
  });

  beforeEach(() => resetThrottle());

  afterAll(async () => {
    await app.close();
    await fx.cleanup();
  });

  /* ---------------------------------------------------------------- */
  describe('partial and full payments against bills', () => {
    it('Rs 40,000 against a Rs 100,000 bill: the bill shows Rs 60,000 remaining', async () => {
      const s = await freshShop();
      const bill = await buy(s);

      const res = await pay(s, {
        allocations: [{ purchaseId: bill.id, amount: '40000' }],
        reference: 'Counter 1',
        notes: 'First instalment',
      }).expect(201);

      expect(res.body).toEqual({
        id: expect.any(String),
        voucherNo: voucher('PAY', 1),
        direction: 'paid',
        paymentDate: TODAY,
        trader: { id: s.kissan.id, name: s.kissan.name },
        amount: '40000.00',
        allocated: '40000.00',
        advance: '0.00',
        method: 'cash',
        reference: 'Counter 1',
        status: 'posted',
        notes: 'First instalment',
        allocations: [
          {
            id: expect.any(String),
            purchaseId: bill.id,
            saleId: null,
            billNo: bill.billNo,
            billDate: TODAY,
            amount: '40000.00',
          },
        ],
        createdBy: expect.any(String),
        createdAt: expect.stringMatching(ISO),
        updatedAt: expect.stringMatching(ISO),
        warnings: [],
      });
      expect((await purchaseOf(s, bill.id)).outstanding).toBe('60000.00');
      const bills = await as(http().get('/purchases'), s.token).expect(200);
      expect(bills.body.data[0].outstanding).toBe('60000.00');

      // The khata: credited 100,000 by the purchase, debited 40,000 now.
      expect(await balance(s, s.kissan.id)).toBe('-60000.00');
      const [entry] = await entriesOf((res.body as SavedPayment).id);
      expect(entry).toMatchObject({
        traderId: s.kissan.id,
        entryDate: TODAY,
        sourceType: 'payment',
        debit: '40000.00',
        credit: '0.00',
        narration: `Payment ${voucher('PAY', 1)}`,
      });
    });

    it('a second payment settles the rest in full; then nothing is left', async () => {
      const s = await freshShop();
      const bill = await buy(s);
      await paid(s, { allocations: [{ purchaseId: bill.id }] });

      const rest = await paid(s, {
        amount: '60000',
        method: 'bank',
        allocations: [{ purchaseId: bill.id }],
      });

      expect(rest.voucherNo).toBe(voucher('PAY', 2));
      expect(rest.allocated).toBe('60000.00');
      expect(rest.advance).toBe('0.00');
      expect((await purchaseOf(s, bill.id)).outstanding).toBe('0.00');
      expect(await balance(s, s.kissan.id)).toBe('0.00');

      const res = await pay(s, {
        amount: '1',
        allocations: [{ purchaseId: bill.id }],
      }).expect(400);
      expect(res.body.errors).toEqual([
        {
          field: 'allocations.0.purchaseId',
          message: `Nothing is left to settle on bill ${bill.billNo}`,
        },
      ]);
    });

    it('the amount paid on the purchase save counts toward the remaining', async () => {
      const s = await freshShop();
      const bill = await buy(s, { paidAmount: '30000' });
      expect(bill.outstanding).toBe('70000.00');

      const res = await pay(s, {
        amount: '70000.01',
        allocations: [{ purchaseId: bill.id, amount: '70000.01' }],
      }).expect(400);
      expect(res.body.errors).toEqual([
        {
          field: 'allocations.0.amount',
          message: `Only Rs 70000.00 is left to settle on bill ${bill.billNo}`,
        },
      ]);

      await pay(s, {
        amount: '70000',
        allocations: [{ purchaseId: bill.id, amount: '70000' }],
      }).expect(201);
      expect((await purchaseOf(s, bill.id)).outstanding).toBe('0.00');
      expect(await balance(s, s.kissan.id)).toBe('0.00');
    });

    it('one payment settles several bills, in list order', async () => {
      const s = await freshShop();
      const first = await buy(s);
      const second = await buy(s);

      const p = await paid(s, {
        amount: '150000',
        allocations: [{ purchaseId: second.id }, { purchaseId: first.id }],
      });

      expect(p.allocations.map((a) => [a.purchaseId, a.amount])).toEqual([
        [second.id, '100000.00'],
        [first.id, '50000.00'],
      ]);
      expect((await purchaseOf(s, second.id)).outstanding).toBe('0.00');
      expect((await purchaseOf(s, first.id)).outstanding).toBe('50000.00');
    });

    it('a receipt from a beopari settles a sale and credits the khata', async () => {
      const s = await freshShop();
      const sale = await sell(s, { receivedAmount: '10000' });
      expect(sale.outstanding).toBe('90000.00');

      const res = await receive(s, {
        amount: '25000',
        method: 'cheque',
        reference: 'Chq 778812',
        allocations: [{ saleId: sale.id }],
      }).expect(201);

      expect(res.body.voucherNo).toBe(voucher('RCT', 1));
      expect(res.body.allocations[0]).toMatchObject({
        saleId: sale.id,
        purchaseId: null,
        billNo: sale.billNo,
        amount: '25000.00',
      });
      expect((await saleOf(s, sale.id)).outstanding).toBe('65000.00');
      const bills = await as(http().get('/sales'), s.token).expect(200);
      expect(bills.body.data[0].outstanding).toBe('65000.00');
      // Debited 100,000, credited 10,000 on the save and 25,000 now.
      expect(await balance(s, s.beopari.id)).toBe('65000.00');
      const [entry] = await entriesOf((res.body as SavedPayment).id);
      expect(entry).toMatchObject({
        sourceType: 'receipt',
        debit: '0.00',
        credit: '25000.00',
        narration: `Receipt ${voucher('RCT', 1)}`,
      });
    });

    it('payments and receipts are two series, even with the shop’s own prefix', async () => {
      const s = await freshShop({ billPrefix: 'AK' });
      await buy(s);
      await sell(s);

      const p = await paid(s);
      const r = (await receive(s).expect(201)).body as SavedPayment;

      expect(p.voucherNo).toBe(`AK-${FY}-000001`);
      expect(r.voucherNo).toBe(`AK-${FY}-000001`);
      expect(p.direction).toBe('paid');
      expect(r.direction).toBe('received');
    });

    it('may be dated earlier, never in the future', async () => {
      const s = await freshShop();
      await buy(s);
      const p = await paid(s, { paymentDate: YESTERDAY });
      expect(p.paymentDate).toBe(YESTERDAY);
      // The khata line is dated on the payment date.
      expect((await entriesOf(p.id))[0].entryDate).toBe(YESTERDAY);

      const tomorrow = new Date(Date.parse(`${TODAY}T12:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      const res = await pay(s, { paymentDate: tomorrow }).expect(400);
      expect(res.body.errors).toEqual([
        {
          field: 'paymentDate',
          message: 'A payment cannot be dated in the future',
        },
      ]);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('advances and over-payment', () => {
    it('more than the bill and the khata: the rest is saved as an advance, with a warning', async () => {
      const s = await freshShop();
      const bill = await buy(s);

      const p = await paid(s, {
        amount: '120000',
        allocations: [{ purchaseId: bill.id }],
      });

      expect(p.allocated).toBe('100000.00');
      expect(p.advance).toBe('20000.00');
      expect(p.warnings).toEqual([
        {
          code: 'OVERPAYMENT',
          message: `The shop owes ${s.kissan.name} Rs 100000.00; this payment is Rs 20000.00 more (an advance)`,
          owed: '100000.00',
          excess: '20000.00',
        },
      ]);
      expect((await purchaseOf(s, bill.id)).outstanding).toBe('0.00');
      // The kissan now owes the shop the advance.
      expect(await balance(s, s.kissan.id)).toBe('20000.00');
      // GET shows no warnings.
      expect((await get(s, p.id).expect(200)).body).toEqual(withoutWarnings(p));
    });

    it('a peshgi with no bills is all advance', async () => {
      const s = await freshShop();

      const p = await paid(s, { amount: '5000' });

      expect(p).toMatchObject({
        allocated: '0.00',
        advance: '5000.00',
        allocations: [],
      });
      expect(p.warnings[0]).toMatchObject({ owed: '0.00', excess: '5000.00' });
      expect(await balance(s, s.kissan.id)).toBe('5000.00');
    });

    it('within what is owed, money not put on a bill is an advance without a warning', async () => {
      const s = await freshShop();
      const bill = await buy(s);

      const p = await paid(s, { amount: '30000' });

      expect(p.advance).toBe('30000.00');
      expect(p.warnings).toEqual([]);
      // The bill is untouched; the khata knows the money was paid.
      expect((await purchaseOf(s, bill.id)).outstanding).toBe('100000.00');
      expect(await balance(s, s.kissan.id)).toBe('-70000.00');
    });

    it('a receipt above what the beopari owes is an advance too', async () => {
      const s = await freshShop();
      const sale = await sell(s);

      const res = await receive(s, {
        amount: '100500',
        allocations: [{ saleId: sale.id }],
      }).expect(201);

      expect(res.body.advance).toBe('500.00');
      expect(res.body.warnings[0]).toMatchObject({
        code: 'OVERPAYMENT',
        owed: '100000.00',
        excess: '500.00',
      });
      expect(await balance(s, s.beopari.id)).toBe('-500.00');
    });

    describe('when the shop blocks over-payment', () => {
      let s: Shop;
      let bill: Purchase;

      beforeAll(async () => {
        s = await freshShop({ overpaymentAction: 'block' });
        bill = await buy(s);
      });

      it('refuses more than the khata owes with 409, saving nothing', async () => {
        const res = await pay(s, {
          amount: '120000',
          allocations: [{ purchaseId: bill.id }],
        }).expect(409);

        const message = `The shop owes ${s.kissan.name} Rs 100000.00; this payment is Rs 20000.00 more (an advance)`;
        expect(res.body).toEqual({
          statusCode: 409,
          message,
          code: 'OVERPAYMENT',
          errors: [{ field: 'amount', message }],
        });
        expect(await paymentsIn(s.shop)).toBe(0);
        expect(await balance(s, s.kissan.id)).toBe('-100000.00');
        expect((await purchaseOf(s, bill.id)).outstanding).toBe('100000.00');
      });

      it('still takes payments up to what is owed (and gave no number away)', async () => {
        const part = await paid(s, { amount: '30000' });
        expect(part.voucherNo).toBe(voucher('PAY', 1));
        expect(part.warnings).toEqual([]);

        const rest = await paid(s, {
          amount: '70000',
          allocations: [{ purchaseId: bill.id }],
        });
        expect(rest.voucherNo).toBe(voucher('PAY', 2));

        await pay(s, { amount: '0.01' }).expect(409);
      });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('validation', () => {
    let s: Shop;
    let bill: Purchase;

    beforeAll(async () => {
      s = await freshShop();
      bill = await buy(s);
    });

    it('needs an Idempotency-Key', async () => {
      const res = await pay(s, {}, null).expect(400);
      expect(res.body.errors[0].field).toBe('Idempotency-Key');
    });

    it('field errors for the body', async () => {
      const res = await pay(s, {
        direction: 'refund',
        amount: '0',
        method: 'card',
      }).expect(400);
      expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual([
        'direction',
        'amount',
        'method',
      ]);
    });

    it('money is paid to kissans and received from beoparis', async () => {
      const toBeopari = await pay(s, { traderId: s.beopari.id }).expect(400);
      expect(toBeopari.body.errors).toEqual([
        {
          field: 'traderId',
          message: 'Money is paid to a kissan (farmer); this trader is not one',
        },
      ]);
      const fromKissan = await pay(s, {
        direction: 'received',
        traderId: s.kissan.id,
      }).expect(400);
      expect(fromKissan.body.errors[0].field).toBe('traderId');
      const unknown = await pay(s, { traderId: UNKNOWN_ID }).expect(400);
      expect(unknown.body.errors).toEqual([
        { field: 'traderId', message: 'Trader not found' },
      ]);
    });

    it('an inactive trader is refused', async () => {
      const k = await trader(s.token);
      await as(http().patch(`/traders/${k.id}`), s.token)
        .send({ isActive: false })
        .expect(200);
      const res = await pay(s, { traderId: k.id }).expect(400);
      expect(res.body.errors).toEqual([
        { field: 'traderId', message: 'This trader is inactive' },
      ]);
    });

    it('a payment settles purchases, a receipt sales', async () => {
      const sale = await sell(s);
      const wrong = await pay(s, {
        allocations: [{ saleId: sale.id }],
      }).expect(400);
      expect(wrong.body.errors).toEqual([
        {
          field: 'allocations.0.saleId',
          message: 'A payment settles purchase bills; choose a purchase',
        },
      ]);
      const wrongReceipt = await receive(s, {
        allocations: [{ purchaseId: bill.id }],
      }).expect(400);
      expect(wrongReceipt.body.errors[0].field).toBe(
        'allocations.0.purchaseId',
      );
    });

    it('only the trader’s own live bills', async () => {
      const other = await trader(s.token);
      const theirs = await buy(s, { traderId: other.id });
      const gone = await buy(s);
      await as(http().post(`/purchases/${gone.id}/cancel`), s.token).expect(
        200,
      );

      const res = await pay(s, {
        amount: '100',
        allocations: [
          { purchaseId: theirs.id },
          { purchaseId: gone.id },
          { purchaseId: UNKNOWN_ID },
        ],
      }).expect(400);

      expect(res.body.errors).toEqual([
        {
          field: 'allocations.0.purchaseId',
          message: 'This bill is of another trader',
        },
        {
          field: 'allocations.1.purchaseId',
          message: 'This bill is cancelled',
        },
        { field: 'allocations.2.purchaseId', message: 'Bill not found' },
      ]);
    });

    it('the bills may not add up to more than the amount', async () => {
      const second = await buy(s);
      const res = await pay(s, {
        amount: '50000',
        allocations: [
          { purchaseId: bill.id, amount: '30000' },
          { purchaseId: second.id, amount: '30000' },
        ],
      }).expect(400);
      expect(res.body.errors).toEqual([
        {
          field: 'allocations.1.amount',
          message: 'Only Rs 20000.00 of the amount is left for this bill',
        },
      ]);
    });

    it('a refused save leaves nothing behind and uses no number', async () => {
      const t = await freshShop();
      await pay(t, { traderId: t.beopari.id }).expect(400);
      expect(await paymentsIn(t.shop)).toBe(0);
      expect((await paid(t)).voucherNo).toBe(voucher('PAY', 1));
    });
  });

  /* ---------------------------------------------------------------- */
  describe('idempotency (double click)', () => {
    it('the same key again returns the same payment with 200', async () => {
      const s = await freshShop();
      const bill = await buy(s);
      const key = randomUUID();
      const body = { allocations: [{ purchaseId: bill.id }] };

      const first = await pay(s, body, key).expect(201);
      const again = await pay(s, body, key).expect(200);

      expect(again.body).toEqual({ ...first.body, warnings: [] });
      expect(await paymentsIn(s.shop)).toBe(1);
      expect(await entriesOf((first.body as SavedPayment).id)).toHaveLength(1);
      expect((await purchaseOf(s, bill.id)).outstanding).toBe('60000.00');
    });

    it('4 clicks at the same moment save one payment', async () => {
      const s = await freshShop();
      const bill = await buy(s);
      const key = randomUUID();

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          pay(s, { allocations: [{ purchaseId: bill.id }] }, key),
        ),
      );

      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
      expect(
        new Set(results.map((r) => (r.body as SavedPayment).id)).size,
      ).toBe(1);
      expect(await paymentsIn(s.shop)).toBe(1);
      expect((await purchaseOf(s, bill.id)).outstanding).toBe('60000.00');
      expect(await balance(s, s.kissan.id)).toBe('-60000.00');
      // The losers gave their voucher number back.
      expect((await paid(s)).voucherNo).toBe(voucher('PAY', 2));
    });

    it('two payments at once cannot both settle the same remaining amount', async () => {
      const s = await freshShop();
      const bill = await buy(s);

      const results = await Promise.all(
        Array.from({ length: 2 }, () =>
          pay(s, {
            amount: '100000',
            allocations: [{ purchaseId: bill.id, amount: '100000' }],
          }),
        ),
      );

      expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
      expect((await purchaseOf(s, bill.id)).outstanding).toBe('0.00');
      expect(await balance(s, s.kissan.id)).toBe('0.00');
    });
  });

  /* ---------------------------------------------------------------- */
  describe('POST /payments/:id/cancel', () => {
    it('reverses the khata and opens the bill again; the voucher number stays', async () => {
      const s = await freshShop();
      const bill = await buy(s);
      const p = await paid(s, { allocations: [{ purchaseId: bill.id }] });

      const res = await cancel(s, p.id).expect(200);

      expect(res.body).toMatchObject({
        id: p.id,
        voucherNo: voucher('PAY', 1),
        status: 'cancelled',
        allocations: p.allocations,
      });
      expect(await balance(s, s.kissan.id)).toBe('-100000.00');
      expect((await purchaseOf(s, bill.id)).outstanding).toBe('100000.00');
      const entries = await entriesOf(p.id);
      expect(entries.map((e) => [e.sourceType, e.debit, e.credit])).toEqual([
        ['payment', '40000.00', '0.00'],
        ['reversal', '0.00', '40000.00'],
      ]);
      expect(entries[1]).toMatchObject({
        entryDate: TODAY,
        narration: `Payment ${voucher('PAY', 1)} cancelled`,
      });

      const again = await cancel(s, p.id).expect(409);
      expect(again.body.code).toBe('PAYMENT_CANCELLED');
      expect(await entriesOf(p.id)).toHaveLength(2);
      expect((await paid(s)).voucherNo).toBe(voucher('PAY', 2));
    });

    it('a cancelled receipt reverses the beopari’s credit', async () => {
      const s = await freshShop();
      const sale = await sell(s);
      const r = (
        await receive(s, { allocations: [{ saleId: sale.id }] }).expect(201)
      ).body as SavedPayment;

      await cancel(s, r.id).expect(200);

      expect(await balance(s, s.beopari.id)).toBe('100000.00');
      expect((await saleOf(s, sale.id)).outstanding).toBe('100000.00');
    });

    it('unknown id → 404; only the owner cancels', async () => {
      const s = await freshShop();
      await cancel(s, UNKNOWN_ID).expect(404);
      await as(http().post('/payments/not-a-uuid/cancel'), s.token).expect(400);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('bills with payments against them', () => {
    let s: Shop;

    beforeAll(async () => {
      s = await freshShop();
    });

    it('a purchase with live vouchers cannot be cancelled until they are', async () => {
      const bill = await buy(s);
      const p = await paid(s, { allocations: [{ purchaseId: bill.id }] });

      const res = await as(
        http().post(`/purchases/${bill.id}/cancel`),
        s.token,
      ).expect(409);
      expect(res.body).toEqual({
        statusCode: 409,
        code: 'BILL_HAS_PAYMENTS',
        message: `${p.voucherNo} settled Rs 40000.00 of this bill, so it cannot be cancelled. Cancel that voucher first.`,
      });

      await cancel(s, p.id).expect(200);
      await as(http().post(`/purchases/${bill.id}/cancel`), s.token).expect(
        200,
      );
      expect(await balance(s, s.kissan.id)).toBe('0.00');
    });

    it('nor moved to another kissan, nor brought below what is settled', async () => {
      const bill = await buy(s, { paidAmount: '10000' });
      await paid(s, {
        amount: '80000',
        allocations: [{ purchaseId: bill.id }],
      });
      const other = await trader(s.token);
      const edit = (body: object) =>
        as(http().patch(`/purchases/${bill.id}`), s.token).send(body);

      expect((await edit({ traderId: other.id }).expect(409)).body.code).toBe(
        'BILL_HAS_PAYMENTS',
      );
      // 900 kg = Rs 90,000 = 10,000 on save + 80,000 by voucher: fine.
      await edit({ items: [{ ...item(s), weightKg: '900' }] }).expect(200);
      const lower = await edit({
        items: [{ ...item(s), weightKg: '899' }],
      }).expect(409);
      expect(lower.body.message).toContain(
        'cannot have a net below Rs 90000.00',
      );
      await edit({ paidAmount: '10000.01' }).expect(409);
      await edit({ notes: 'still editable' }).expect(200);
      expect((await purchaseOf(s, bill.id)).outstanding).toBe('0.00');
    });

    it('a sale with live receipts cannot be cancelled either', async () => {
      const sale = await sell(s);
      await receive(s, { allocations: [{ saleId: sale.id }] }).expect(201);

      const res = await as(
        http().post(`/sales/${sale.id}/cancel`),
        s.token,
      ).expect(409);
      expect(res.body.code).toBe('BILL_HAS_PAYMENTS');
    });

    it('bill outstanding amounts and the khata agree (reconciliation passes)', async () => {
      const reconciliation = app.get(LedgerReconciliation);
      const result = await reconciliation.run([s.shop]);
      expect(result).toMatchObject({ ok: true, mismatches: [] });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /payments and GET /payments/:id', () => {
    let s: Shop;
    const ids = {} as Record<'cash' | 'bank' | 'receipt' | 'old', string>;

    beforeAll(async () => {
      s = await freshShop();
      await buy(s);
      await sell(s);
      ids.old = (await paid(s, { paymentDate: EARLIER, amount: '100' })).id;
      ids.cash = (await paid(s, { amount: '200' })).id;
      ids.bank = (await paid(s, { amount: '300', method: 'bank' })).id;
      ids.receipt = (
        (await receive(s, { amount: '400' }).expect(201)).body as SavedPayment
      ).id;
      await cancel(s, ids.bank).expect(200);
    });

    const idsOf = (res: request.Response) =>
      (res.body.data as PaymentSummary[]).map((p) => p.id);

    it('newest first, with meta', async () => {
      const res = await list(s).expect(200);
      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 4 });
      expect(idsOf(res)).toEqual([ids.receipt, ids.bank, ids.cash, ids.old]);
      expect(res.body.data[0]).toEqual({
        id: ids.receipt,
        voucherNo: voucher('RCT', 1),
        direction: 'received',
        paymentDate: TODAY,
        trader: { id: s.beopari.id, name: s.beopari.name },
        amount: '400.00',
        allocated: '0.00',
        advance: '400.00',
        method: 'cash',
        reference: null,
        status: 'posted',
        notes: null,
        createdAt: expect.stringMatching(ISO),
        updatedAt: expect.stringMatching(ISO),
      });
    });

    it('filters by direction, trader, method, status, dates and search', async () => {
      expect(idsOf(await list(s, { direction: 'received' }))).toEqual([
        ids.receipt,
      ]);
      expect(idsOf(await list(s, { trader: s.kissan.id }))).toEqual([
        ids.bank,
        ids.cash,
        ids.old,
      ]);
      expect(idsOf(await list(s, { method: 'bank' }))).toEqual([ids.bank]);
      expect(idsOf(await list(s, { status: 'cancelled' }))).toEqual([ids.bank]);
      expect(idsOf(await list(s, { from: EARLIER, to: EARLIER }))).toEqual([
        ids.old,
      ]);
      expect(idsOf(await list(s, { search: 'RCT-' }))).toEqual([ids.receipt]);
      expect(idsOf(await list(s, { search: s.beopari.name }))).toEqual([
        ids.receipt,
      ]);
      expect(
        idsOf(await list(s, { sort: 'voucherNo', direction: 'paid' })),
      ).toEqual([ids.old, ids.cash, ids.bank]);
      const page = await list(s, { limit: 3, page: 2 }).expect(200);
      expect(idsOf(page)).toEqual([ids.old]);
      await list(s, { from: TODAY, to: EARLIER }).expect(400);
      await list(s, { method: 'card' }).expect(400);
    });

    it('GET /payments/:id; an unknown id is 404', async () => {
      const res = await get(s, ids.cash).expect(200);
      expect(res.body).toMatchObject({ id: ids.cash, allocations: [] });
      await get(s, UNKNOWN_ID).expect(404);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /payments/cash-book', () => {
    let s: Shop;

    beforeAll(async () => {
      s = await freshShop();
      await buy(s);
      await sell(s);
      // Before the range: in 5,000, out 1,000 → opening cash 4,000.
      await receive(s, { paymentDate: EARLIER, amount: '5000' }).expect(201);
      await paid(s, { paymentDate: EARLIER, amount: '1000' });
      // Yesterday: in 20,000, out 7,500.50; bank and cancelled don't count.
      await receive(s, { paymentDate: YESTERDAY, amount: '20000' }).expect(201);
      await paid(s, { paymentDate: YESTERDAY, amount: '7500.50' });
      await paid(s, { paymentDate: YESTERDAY, amount: '999', method: 'bank' });
      const gone = await paid(s, { paymentDate: YESTERDAY, amount: '888' });
      await cancel(s, gone.id).expect(200);
      // Today: out 3,000.
      await paid(s, { amount: '3000' });
    });

    it('daily cash in and out with the closing cash', async () => {
      const res = await cashBook(s, { from: YESTERDAY, to: TODAY }).expect(200);

      expect(res.body).toEqual({
        from: YESTERDAY,
        to: TODAY,
        openingCash: '4000.00',
        days: [
          {
            date: YESTERDAY,
            cashIn: '20000.00',
            cashOut: '7500.50',
            closingCash: '16499.50',
          },
          {
            date: TODAY,
            cashIn: '0.00',
            cashOut: '3000.00',
            closingCash: '13499.50',
          },
        ],
        totals: { cashIn: '20000.00', cashOut: '10500.50' },
        closingCash: '13499.50',
      });
    });

    it('defaults to today', async () => {
      const res = await cashBook(s).expect(200);
      expect(res.body).toMatchObject({
        from: TODAY,
        to: TODAY,
        openingCash: '16499.50',
        closingCash: '13499.50',
      });
    });

    it('a bad or too long range is 400', async () => {
      await cashBook(s, { from: TODAY, to: YESTERDAY }).expect(400);
      await cashBook(s, { from: '2024-01-01', to: '2025-01-01' }).expect(400);
      await cashBook(s, { from: '2025-01-01', to: '2025-12-31' }).expect(200);
      await cashBook(s, { from: 'yesterday' }).expect(400);
    });

    it('the reconciliation passes after payments, receipts and cancels', async () => {
      const result = await app.get(LedgerReconciliation).run([s.shop]);
      expect(result).toMatchObject({ ok: true, mismatches: [] });
    });

    it('and flags a payment changed around the service', async () => {
      const t = await freshShop();
      const p = await paid(t, { amount: '700' });
      await fx.db
        .update(payments)
        .set({ amount: '701.00' })
        .where(eq(payments.id, p.id));
      const alert = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        const result = await app.get(LedgerReconciliation).run([t.shop]);
        expect(result.mismatches).toEqual([
          {
            check: 'document',
            tenantId: t.shop,
            traderId: t.kissan.id,
            sourceType: 'payment',
            sourceId: p.id,
            entryDate: null,
            expected: '701.00',
            actual: '700.00',
          },
        ]);
      } finally {
        alert.mockRestore();
      }
    });
  });

  /* ---------------------------------------------------------------- */
  describe('permissions', () => {
    let s: Shop;

    beforeAll(async () => {
      // Shop A, where the manager and operator work.
      s = {
        shop: shopA,
        token: tokens.ownerA,
        kissan: await trader(tokens.ownerA),
        beopari: await trader(tokens.ownerA, { type: 'beopari' }),
        wheat: await commodity(tokens.ownerA),
      };
    });

    it('operators and managers create and view; only the owner cancels', async () => {
      for (const token of [tokens.operator, tokens.manager]) {
        const p = (
          await pay(s, { amount: '10' }, randomUUID(), token).expect(201)
        ).body as SavedPayment;
        await get(s, p.id, token).expect(200);
        await list(s, {}, token).expect(200);
        await cashBook(s, {}, token).expect(200);
        await cancel(s, p.id, token).expect(403);
        await cancel(s, p.id, tokens.ownerA).expect(200);
      }
    });

    it('signed out → 401', async () => {
      await pay(s, {}, randomUUID(), null).expect(401);
      await as(http().get('/payments'), null).expect(401);
      await as(http().get('/payments/cash-book'), null).expect(401);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('multi-tenant isolation', () => {
    let a: Shop;
    let p: SavedPayment;
    let bill: Purchase;
    let b: Shop;

    beforeAll(async () => {
      a = await freshShop();
      bill = await buy(a);
      p = await paid(a, { allocations: [{ purchaseId: bill.id }] });
      b = {
        shop: shopB,
        token: tokens.ownerB,
        kissan: await trader(tokens.ownerB),
        beopari: await trader(tokens.ownerB, { type: 'beopari' }),
        wheat: await commodity(tokens.ownerB),
      };
    });

    it('shop B cannot read or cancel shop A’s payment (404, not 403)', async () => {
      await get(b, p.id).expect(404);
      await cancel(b, p.id).expect(404);
      expect((await get(a, p.id).expect(200)).body).toEqual(withoutWarnings(p));
      expect(await entriesOf(p.id)).toHaveLength(1);
    });

    it('shop B’s list and cash book never have shop A’s payments', async () => {
      const res = await list(b).expect(200);
      expect(idsOf(res)).not.toContain(p.id);
      const byTrader = await list(b, { trader: a.kissan.id }).expect(200);
      expect(byTrader.body.meta.total).toBe(0);
      const book = await cashBook(b).expect(200);
      expect(book.body.totals).toEqual({ cashIn: '0.00', cashOut: '0.00' });
    });

    it('shop B cannot pay shop A’s kissan, settle its bill or replay its key', async () => {
      const key = randomUUID();
      await pay(a, {}, key).expect(201);
      const res = await pay(
        b,
        { traderId: a.kissan.id, allocations: [{ purchaseId: bill.id }] },
        key,
      ).expect(400);
      expect(res.body.errors).toEqual([
        { field: 'traderId', message: 'Trader not found' },
        { field: 'allocations.0.purchaseId', message: 'Bill not found' },
      ]);
      // Shop B's own kissan, same key: a new payment of its own.
      const own = await pay(b, { amount: '1' }, key).expect(201);
      expect(own.body.voucherNo).toBe(voucher('PAY', 1));
      expect((await purchaseOf(a, bill.id)).outstanding).toBe('60000.00');
    });

    it('row-level security: shop B’s role sees no shop A rows even by raw query', async () => {
      const seen = await fx.db.transaction(async (tx) => {
        await tx.execute(sql`set local role app_tenant`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${shopB}, true)`,
        );
        const r = await tx.execute(
          sql`select (select count(*) from payments where id = ${p.id})::int as p,
                     (select count(*) from payment_allocations where payment_id = ${p.id})::int as a`,
        );
        return r.rows[0];
      });
      expect(seen).toEqual({ p: 0, a: 0 });
      const rows = await fx.db
        .select()
        .from(paymentAllocations)
        .where(eq(paymentAllocations.paymentId, p.id));
      expect(rows).toHaveLength(1);
    });

    const idsOf = (res: request.Response) =>
      (res.body.data as PaymentSummary[]).map((x) => x.id);
  });
});
