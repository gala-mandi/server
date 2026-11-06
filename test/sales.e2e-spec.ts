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
  saleItems,
  sales,
  tenantSettings,
} from '../src/database/schema';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import type { Commodity } from '../src/modules/commodities/commodities.dto';
import { LedgerReconciliation } from '../src/modules/ledger/ledger-reconciliation.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { financialYear } from '../src/modules/numbering/bill-number';
import type { Purchase } from '../src/modules/purchases/purchases.dto';
import type { SaleSummary, SavedSale } from '../src/modules/sales/sales.dto';
import type { Trader } from '../src/modules/traders/traders.dto';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const TODAY = karachiDate();
const YESTERDAY = previousDate(TODAY);
// Same financial year as today (but on 1–3 July), so one bill series.
const EARLIER = previousDate(previousDate(YESTERDAY));
const FY = financialYear(TODAY, null);
const bill = (n: number) => `SAL-${FY}-${String(n).padStart(6, '0')}`;

type Token = 'ownerA' | 'ownerB' | 'manager' | 'operator';

describe('Sales /sales (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;
  let shopA: string;
  let shopB: string;
  const tokens = {} as Record<Token, string>;

  /** Shop A's master data. */
  let wheat: Commodity;
  let beopari: Trader;

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
    token: string | null = tokens.ownerA,
    key: string | null = randomUUID(),
  ) => {
    const req = as(http().post('/sales'), token);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send({ buyerId: beopari.id, items: [item()], ...body });
  };
  const created = async (
    body: Record<string, unknown> = {},
    token = tokens.ownerA,
  ): Promise<SavedSale> =>
    (await create(body, token).expect(201)).body as SavedSale;

  const get = (id: string, token = tokens.ownerA) =>
    as(http().get(`/sales/${id}`), token);
  const list = (
    query: Record<string, unknown> = {},
    token: string | null = tokens.ownerA,
  ) => as(http().get('/sales'), token).query(query);
  const patch = (id: string, body: object, token = tokens.ownerA) =>
    as(http().patch(`/sales/${id}`), token).send(body);
  const cancel = (id: string, token = tokens.ownerA) =>
    as(http().post(`/sales/${id}/cancel`), token);

  /** The stored sale as GET returns it (no warnings). */
  const withoutWarnings = (sale: SavedSale) =>
    Object.fromEntries(
      Object.entries(sale).filter(([key]) => key !== 'warnings'),
    );

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
        type: 'beopari',
        name: `Beopari ${randomUUID().slice(0, 8)}`,
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

  /** A purchase from a new kissan of the shop: its items are lots. */
  async function purchase(
    items: Record<string, unknown>[],
    token = tokens.ownerA,
  ): Promise<Purchase> {
    const kissan = await trader({ type: 'kissan' }, token);
    const res = await as(http().post('/purchases'), token)
      .set('Idempotency-Key', randomUUID())
      .send({ traderId: kissan.id, items })
      .expect(201);
    return res.body as Purchase;
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

  const salesIn = async (tenantId: string) =>
    (
      await fx.db
        .select({ n: count() })
        .from(sales)
        .where(eq(sales.tenantId, tenantId))
    )[0].n;

  /** A new shop (no charges) with an owner, its own series and master data. */
  async function freshShop(settings: { creditLimitAction?: string } = {}) {
    const shop = await fx.tenant();
    await fx.db.insert(tenantSettings).values({ tenantId: shop, ...settings });
    const owner = await fx.user('owner', shop);
    const token = await login(owner.phone);
    return {
      shop,
      token,
      beopari: await trader({}, token),
      wheat: await commodity({}, token),
    };
  }
  type Shop = Awaited<ReturnType<typeof freshShop>>;

  /** A sale in a fresh shop: net = gross = Rs 100,000 per default item. */
  const saveIn = (
    s: Shop,
    body: Record<string, unknown> = {},
    key: string | null = randomUUID(),
  ) =>
    create(
      {
        buyerId: s.beopari.id,
        items: [item({ commodityId: s.wheat.id })],
        ...body,
      },
      s.token,
      key,
    );

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
    beopari = await trader();
  });

  beforeEach(() => resetThrottle());

  afterAll(async () => {
    await app.close();
    await fx.cleanup();
  });

  /* ---------------------------------------------------------------- */
  describe('POST /sales', () => {
    it('saves the sale with its bill number; the beopari is debited with the receivable', async () => {
      const b = await trader();

      const res = await create(
        { buyerId: b.id, notes: 'Truck 1' },
        tokens.operator,
      ).expect(201);
      const s = res.body as SavedSale;

      expect(s).toEqual({
        id: expect.any(String),
        billNo: expect.stringMatching(new RegExp(`^SAL-${FY}-\\d{6}$`)),
        saleDate: TODAY,
        buyer: { id: b.id, name: b.name },
        grossAmount: '100000.00',
        totalCharges: '2700.00',
        rounding: '0.00',
        netAmount: '102700.00',
        receivedAmount: '0.00',
        outstanding: '102700.00',
        status: 'posted',
        notes: 'Truck 1',
        items: [
          {
            id: expect.any(String),
            commodityId: wheat.id,
            commodityName: wheat.name,
            purchaseItemId: null,
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
        warnings: [],
        createdBy: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(await balance(b.id)).toBe('102700.00');
      expect(await entriesOf(s.id)).toEqual([
        expect.objectContaining({
          traderId: b.id,
          entryDate: TODAY,
          sourceType: 'sale',
          debit: '102700.00',
          credit: '0.00',
          narration: `Sale ${s.billNo}`,
        }),
      ]);
      // GET returns the same sale.
      expect((await get(s.id).expect(200)).body).toEqual(withoutWarnings(s));
    });

    it('several items: summed before the net is rounded once', async () => {
      const s = await created({
        items: [item({ weightKg: '1000.333' }), item({ weightKg: '1000.333' })],
      });

      expect(s).toMatchObject({
        grossAmount: '200066.60',
        totalCharges: '5401.66',
        netAmount: '205468.00',
      });
      expect(
        new Decimal(s.grossAmount)
          .plus(s.totalCharges)
          .plus(s.rounding)
          .toFixed(2),
      ).toBe(s.netAmount);
    });

    it('keeps the items in the order typed', async () => {
      const weights = ['100', '200', '300', '400', '500', '600'];
      const s = await created({
        items: weights.map((weightKg) => item({ weightKg })),
      });
      expect(s.items.map((i) => i.weightKg)).toEqual(
        weights.map((w) => `${w}.000`),
      );
    });

    it('an amount received on the same save is credited back to the beopari', async () => {
      const b = await trader();

      const s = await created({ buyerId: b.id, receivedAmount: '40000' });

      expect(s.receivedAmount).toBe('40000.00');
      expect(await balance(b.id)).toBe('62700.00');
      expect(
        (await entriesOf(s.id)).map((e) => [
          e.sourceType,
          e.debit,
          e.credit,
          e.narration,
        ]),
      ).toEqual([
        ['sale', '102700.00', '0.00', `Sale ${s.billNo}`],
        ['sale', '0.00', '40000.00', `Received on sale ${s.billNo}`],
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
      expect(manual.netAmount).toBe('100750.00');
    });

    it('rates and charges are copied: later setting changes leave the bill as it was', async () => {
      const s = await freshShop();
      await fx.db
        .update(tenantSettings)
        .set({ defaultCommissionPct: '2' })
        .where(eq(tenantSettings.tenantId, s.shop));
      const sale = (await saveIn(s).expect(201)).body as SavedSale;

      await fx.db
        .update(tenantSettings)
        .set({ defaultCommissionPct: '5' })
        .where(eq(tenantSettings.tenantId, s.shop));

      const again = await get(sale.id, s.token).expect(200);
      expect(again.body).toEqual(withoutWarnings(sale));
      expect(again.body.netAmount).toBe('102000.00');
    });

    it('a back-dated sale (a paper bill entered late) is dated that day in the khata', async () => {
      const s = await created({ saleDate: YESTERDAY });
      expect(s.saleDate).toBe(YESTERDAY);
      expect((await entriesOf(s.id))[0].entryDate).toBe(YESTERDAY);
    });

    it('a tenant_id in the body is ignored', async () => {
      const s = await created({ tenant_id: shopB });
      expect(
        (
          await fx.db
            .select({ tenantId: sales.tenantId })
            .from(sales)
            .where(eq(sales.id, s.id))
        )[0].tenantId,
      ).toBe(shopA);
    });

    describe('refused (400), nothing saved, no bill number used', () => {
      let s: Shop;

      beforeAll(async () => {
        s = await freshShop();
      });

      const save = (body: Record<string, unknown>) => saveIn(s, body);

      async function expectNothingSaved() {
        expect(await salesIn(s.shop)).toBe(0);
        expect(
          await fx.db
            .select()
            .from(numberSequences)
            .where(
              and(
                eq(numberSequences.tenantId, s.shop),
                eq(numberSequences.docType, 'sale'),
              ),
            ),
        ).toEqual([]);
      }

      it('inactive beopari', async () => {
        const b = await trader({ isActive: false }, s.token);
        const res = await save({ buyerId: b.id }).expect(400);
        expect(res.body.errors).toEqual([
          { field: 'buyerId', message: 'This beopari is inactive' },
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

      it('a kissan or an arhti is not a beopari', async () => {
        for (const type of ['kissan', 'arhti']) {
          const t = await trader({ type }, s.token);
          const res = await save({ buyerId: t.id }).expect(400);
          expect(res.body.errors).toEqual([
            {
              field: 'buyerId',
              message: 'Choose a beopari (buyer); this trader is not one',
            },
          ]);
        }
        await expectNothingSaved();
      });

      it('another shop’s beopari or commodity looks unknown', async () => {
        const res = await save({
          buyerId: beopari.id,
          items: [item({ commodityId: wheat.id })],
        }).expect(400);
        expect(res.body.errors).toEqual([
          { field: 'buyerId', message: 'Beopari not found' },
          { field: 'items.0.commodityId', message: 'Commodity not found' },
        ]);
        await expectNothingSaved();
      });

      it('a date in the future', async () => {
        const res = await save({ saleDate: '2999-01-01' }).expect(400);
        expect(res.body.errors[0].field).toBe('saleDate');
        await expectNothingSaved();
      });

      it('received more than the net', async () => {
        const res = await save({ receivedAmount: '100000.01' }).expect(400);
        expect(res.body.errors[0].field).toBe('receivedAmount');
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
        const res = await saveIn(s, {}, null).expect(400);
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
  describe('lot linking (commission-agent flow)', () => {
    it('a sale item can name the kissan’s lot it was sold from', async () => {
      const p = await purchase([item(), item({ weightKg: '500' })]);

      const s = await created({
        items: [
          item({ purchaseItemId: p.items[1].id, weightKg: '500' }),
          item(),
        ],
      });

      expect(s.items.map((i) => i.purchaseItemId)).toEqual([
        p.items[1].id,
        null,
      ]);
      const rows = await fx.db
        .select({ lot: saleItems.purchaseItemId })
        .from(saleItems)
        .where(eq(saleItems.saleId, s.id))
        .orderBy(asc(saleItems.createdAt));
      expect(rows.map((r) => r.lot)).toEqual([p.items[1].id, null]);
    });

    it('refuses a lot of another shop, of a cancelled purchase, of another commodity, or unknown', async () => {
      const b = await freshShop();
      const theirs = await purchase(
        [item({ commodityId: b.wheat.id })],
        b.token,
      );
      const cancelledLot = await purchase([item()]);
      await as(
        http().post(`/purchases/${cancelledLot.id}/cancel`),
        tokens.ownerA,
      ).expect(200);
      const rice = await commodity();
      const riceLot = await purchase([item({ commodityId: rice.id })]);

      const res = await create({
        items: [
          item({ purchaseItemId: theirs.items[0].id }),
          item({ purchaseItemId: cancelledLot.items[0].id }),
          item({ purchaseItemId: riceLot.items[0].id }),
          item({ purchaseItemId: UNKNOWN_ID }),
        ],
      }).expect(400);

      expect(res.body.errors).toEqual([
        { field: 'items.0.purchaseItemId', message: 'Lot not found' },
        {
          field: 'items.1.purchaseItemId',
          message: 'The purchase of this lot is cancelled',
        },
        {
          field: 'items.2.purchaseItemId',
          message: 'This lot is of another commodity',
        },
        { field: 'items.3.purchaseItemId', message: 'Lot not found' },
      ]);
    });

    it('a lot replaced by an edit of its purchase is no longer offered', async () => {
      const p = await purchase([item()]);
      await as(http().patch(`/purchases/${p.id}`), tokens.ownerA)
        .send({ items: [item({ weightKg: '900' })] })
        .expect(200);

      const res = await create({
        items: [item({ purchaseItemId: p.items[0].id })],
      }).expect(400);
      expect(res.body.errors).toEqual([
        { field: 'items.0.purchaseItemId', message: 'Lot not found' },
      ]);
    });

    it('on an edit, a lot already on the bill may stay after its purchase was cancelled', async () => {
      const p = await purchase([item()]);
      const s = await created({
        items: [item({ purchaseItemId: p.items[0].id })],
      });
      await as(http().post(`/purchases/${p.id}/cancel`), tokens.ownerA).expect(
        200,
      );

      const edited = await patch(s.id, {
        items: [item({ purchaseItemId: p.items[0].id, weightKg: '800' })],
      }).expect(200);
      expect(edited.body.items[0]).toMatchObject({
        purchaseItemId: p.items[0].id,
        weightKg: '800.000',
      });
      // A charges-only edit keeps the links too.
      const again = await patch(s.id, {
        charges: { labourPerBag: '0' },
      }).expect(200);
      expect(again.body.items[0].purchaseItemId).toBe(p.items[0].id);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('credit limit', () => {
    describe('shop setting "warn" (the default)', () => {
      let s: Shop;

      beforeAll(async () => {
        s = await freshShop();
      });

      it('within the limit → no warning; over it → saved with a warning', async () => {
        const b = await trader({ creditLimit: '150000' }, s.token);

        const first = await saveIn(s, { buyerId: b.id }).expect(201);
        expect(first.body.warnings).toEqual([]);

        const second = await saveIn(s, { buyerId: b.id }).expect(201);
        expect(second.body.warnings).toEqual([
          {
            code: 'CREDIT_LIMIT_EXCEEDED',
            message: `${b.name} would owe Rs 200000.00, above the credit limit of Rs 150000.00`,
            balance: '200000.00',
            creditLimit: '150000.00',
          },
        ]);
        expect(second.body.status).toBe('posted');
        expect(await balance(b.id, s.token)).toBe('200000.00');
      });

      it('the opening balance counts; exactly at the limit is fine', async () => {
        const b = await trader(
          { creditLimit: '150000', openingBalance: '50000' },
          s.token,
        );
        const res = await saveIn(s, { buyerId: b.id }).expect(201);
        expect(res.body.warnings).toEqual([]);
      });

      it('an amount received on the same save keeps the buyer within it', async () => {
        const b = await trader({ creditLimit: '50000' }, s.token);
        const res = await saveIn(s, {
          buyerId: b.id,
          receivedAmount: '60000',
        }).expect(201);
        expect(res.body.warnings).toEqual([]);
        expect(await balance(b.id, s.token)).toBe('40000.00');
      });

      it('no limit set → never a warning', async () => {
        const res = await saveIn(s, {
          items: [item({ commodityId: s.wheat.id, weightKg: '100000' })],
        }).expect(201);
        expect(res.body.warnings).toEqual([]);
      });

      it('an edit that raises the balance above the limit warns; one that lowers it does not', async () => {
        const b = await trader({ creditLimit: '150000' }, s.token);
        const sale = (await saveIn(s, { buyerId: b.id }).expect(201))
          .body as SavedSale;

        const up = await patch(
          sale.id,
          { items: [item({ commodityId: s.wheat.id, weightKg: '2000' })] },
          s.token,
        ).expect(200);
        expect(up.body.warnings).toEqual([
          expect.objectContaining({
            code: 'CREDIT_LIMIT_EXCEEDED',
            balance: '200000.00',
          }),
        ]);

        const down = await patch(
          sale.id,
          { items: [item({ commodityId: s.wheat.id, weightKg: '1800' })] },
          s.token,
        ).expect(200);
        // Still above the limit, but the edit made it smaller.
        expect(down.body.warnings).toEqual([]);
        const notes = await patch(sale.id, { notes: 'ok' }, s.token).expect(
          200,
        );
        expect(notes.body.warnings).toEqual([]);
      });
    });

    describe('shop setting "block"', () => {
      let s: Shop;

      beforeAll(async () => {
        s = await freshShop({ creditLimitAction: 'block' });
      });

      it('over the limit → 409 CREDIT_LIMIT_EXCEEDED, nothing saved, no number used', async () => {
        const b = await trader({ creditLimit: '150000' }, s.token);
        await saveIn(s, { buyerId: b.id }).expect(201);

        const res = await saveIn(s, { buyerId: b.id }).expect(409);

        expect(res.body).toMatchObject({
          statusCode: 409,
          code: 'CREDIT_LIMIT_EXCEEDED',
          message: `${b.name} would owe Rs 200000.00, above the credit limit of Rs 150000.00`,
          errors: [{ field: 'buyerId', message: expect.any(String) }],
        });
        expect(await balance(b.id, s.token)).toBe('100000.00');
        expect(await salesIn(s.shop)).toBe(1);
        // A sale within the limit takes the next number: no gap.
        const ok = await saveIn(s, {
          buyerId: b.id,
          receivedAmount: '60000',
        }).expect(201);
        expect(ok.body.billNo).toBe(bill(2));
      });

      it('an edit over the limit → 409 and the sale stays as it was', async () => {
        const b = await trader({ creditLimit: '150000' }, s.token);
        const sale = (await saveIn(s, { buyerId: b.id }).expect(201))
          .body as SavedSale;

        const res = await patch(
          sale.id,
          { items: [item({ commodityId: s.wheat.id, weightKg: '2000' })] },
          s.token,
        ).expect(409);
        expect(res.body.code).toBe('CREDIT_LIMIT_EXCEEDED');
        expect((await get(sale.id, s.token).expect(200)).body).toEqual(
          withoutWarnings(sale),
        );
        expect(await entriesOf(sale.id)).toHaveLength(1);

        // With a receipt on the same edit it fits.
        await patch(
          sale.id,
          {
            items: [item({ commodityId: s.wheat.id, weightKg: '2000' })],
            receivedAmount: '60000',
          },
          s.token,
        ).expect(200);
        expect(await balance(b.id, s.token)).toBe('140000.00');
      });

      it('moving a sale to a buyer at their limit is blocked', async () => {
        const full = await trader(
          { creditLimit: '100000', openingBalance: '100000' },
          s.token,
        );
        const sale = (await saveIn(s).expect(201)).body as SavedSale;

        await patch(sale.id, { buyerId: full.id }, s.token).expect(409);
        expect(await balance(full.id, s.token)).toBe('100000.00');
      });

      it('a buyer already over the limit can still be corrected down or cancelled', async () => {
        const b = await trader(
          { creditLimit: '100000', openingBalance: '500000' },
          s.token,
        );
        // Saved before the limit was set this low.
        await fx.db
          .update(tenantSettings)
          .set({ creditLimitAction: 'warn' })
          .where(eq(tenantSettings.tenantId, s.shop));
        const sale = (await saveIn(s, { buyerId: b.id }).expect(201))
          .body as SavedSale;
        await fx.db
          .update(tenantSettings)
          .set({ creditLimitAction: 'block' })
          .where(eq(tenantSettings.tenantId, s.shop));

        const down = await patch(
          sale.id,
          { items: [item({ commodityId: s.wheat.id, weightKg: '500' })] },
          s.token,
        ).expect(200);
        expect(down.body.warnings).toEqual([]);
        await cancel(sale.id, s.token).expect(200);
        expect(await balance(b.id, s.token)).toBe('500000.00');
      });

      it('the owner switches the setting through PATCH /settings', async () => {
        const res = await as(http().patch('/settings'), s.token)
          .send({ creditLimitAction: 'warn' })
          .expect(200);
        expect(res.body.creditLimitAction).toBe('warn');
        const b = await trader({ creditLimit: '1' }, s.token);
        const warned = await saveIn(s, { buyerId: b.id }).expect(201);
        expect(warned.body.warnings).toHaveLength(1);
        await as(http().patch('/settings'), s.token)
          .send({ creditLimitAction: 'block' })
          .expect(200);
      });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('idempotency (double-click Save)', () => {
    it('the same key again returns the same sale (200), only one saved', async () => {
      const key = randomUUID();
      const first = await create({}, tokens.operator, key).expect(201);
      const again = await create({}, tokens.operator, key).expect(200);

      expect(again.body).toEqual(first.body);
      const rows = await fx.db
        .select()
        .from(sales)
        .where(and(eq(sales.tenantId, shopA), eq(sales.idempotencyKey, key)));
      expect(rows).toHaveLength(1);
      expect(await entriesOf(rows[0].id)).toHaveLength(1);
    });

    it('two clicks at the same moment: one sale, one bill number', async () => {
      const s = await freshShop();
      const key = randomUUID();

      const results = await Promise.all(
        Array.from({ length: 4 }, () => saveIn(s, {}, key)),
      );

      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
      expect(new Set(results.map((r) => (r.body as SavedSale).id)).size).toBe(
        1,
      );
      expect(await salesIn(s.shop)).toBe(1);
      expect(await balance(s.beopari.id, s.token)).toBe('100000.00');
      // The losing saves rolled back their numbers: the next bill is 2.
      const next = await saveIn(s).expect(201);
      expect(next.body.billNo).toBe(bill(2));
    });

    it('a key is per shop, and separate from purchase keys', async () => {
      const key = randomUUID();
      await create({}, tokens.ownerA, key).expect(201);
      const kissan = await trader({ type: 'kissan' });
      await as(http().post('/purchases'), tokens.ownerA)
        .set('Idempotency-Key', key)
        .send({ traderId: kissan.id, items: [item()] })
        .expect(201);
      const b = await freshShop();
      const res = await saveIn(b, {}, key).expect(201);
      expect(res.body.buyer.id).toBe(b.beopari.id);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('transaction (integration)', () => {
    it('a failure halfway (khata write) saves nothing: no sale, items or number', async () => {
      const s = await freshShop();
      const ledger = app.get(LedgerService);
      const spy = jest
        .spyOn(ledger, 'post')
        .mockRejectedValueOnce(new Error('connection lost'));
      const quiet = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      try {
        await saveIn(s).expect(500);
      } finally {
        spy.mockRestore();
        quiet.mockRestore();
      }

      expect(await salesIn(s.shop)).toBe(0);
      expect(
        await fx.db
          .select()
          .from(saleItems)
          .where(eq(saleItems.tenantId, s.shop)),
      ).toEqual([]);
      expect(await balance(s.beopari.id, s.token)).toBe('0.00');
      const next = await saveIn(s).expect(201);
      expect(next.body.billNo).toBe(bill(1));
    });

    it('a failure in an edit keeps the old sale and khata', async () => {
      const s = await created();
      const ledger = app.get(LedgerService);
      const spy = jest
        .spyOn(ledger, 'post')
        .mockRejectedValueOnce(new Error('connection lost'));
      const quiet = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      try {
        await patch(s.id, { items: [item({ weightKg: '2000' })] }).expect(500);
      } finally {
        spy.mockRestore();
        quiet.mockRestore();
      }

      expect((await get(s.id).expect(200)).body).toEqual(withoutWarnings(s));
      expect(await entriesOf(s.id)).toHaveLength(1);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('concurrency', () => {
    it('operators saving at the same time get different, consecutive bill numbers', async () => {
      const s = await freshShop();
      const operator = await fx.user('operator', s.shop);
      const opToken = await login(operator.phone);
      const body = {
        buyerId: s.beopari.id,
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
      expect(await balance(s.beopari.id, s.token)).toBe('800000.00');
    });

    it('sales and purchases of one shop keep separate series', async () => {
      const s = await freshShop();
      const kissan = await trader({ type: 'kissan' }, s.token);
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          i % 2
            ? saveIn(s)
            : as(http().post('/purchases'), s.token)
                .set('Idempotency-Key', randomUUID())
                .send({
                  traderId: kissan.id,
                  items: [item({ commodityId: s.wheat.id })],
                }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(4).fill(201));
      expect(results.map((r) => r.body.billNo as string).sort()).toEqual([
        `PUR-${FY}-000001`,
        `PUR-${FY}-000002`,
        bill(1),
        bill(2),
      ]);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /sales', () => {
    let s: Shop;
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
        ((await saveIn(s, body).expect(201)).body as SavedSale).id;

      ids.old = await save({ saleDate: EARLIER });
      ids.rice = await save({
        buyerId: other.id,
        items: [
          item({ commodityId: s.wheat.id }),
          item({ commodityId: rice.id }),
        ],
      });
      ids.cancelled = await save({});
      await cancel(ids.cancelled, s.token).expect(200);
      ids.today = await save({});
    });

    const idsOf = (res: request.Response) =>
      (res.body.data as SaleSummary[]).map((p) => p.id);

    it('newest first, with paging meta', async () => {
      const res = await list({}, s.token).expect(200);
      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 4 });
      expect(idsOf(res)).toEqual([ids.today, ids.cancelled, ids.rice, ids.old]);
      expect(res.body.data[0]).toEqual({
        id: ids.today,
        billNo: bill(4),
        saleDate: TODAY,
        buyer: { id: s.beopari.id, name: s.beopari.name },
        grossAmount: '100000.00',
        totalCharges: '0.00',
        rounding: '0.00',
        netAmount: '100000.00',
        receivedAmount: '0.00',
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

    it('by buyer, commodity and status', async () => {
      expect(idsOf(await list({ buyer: other.id }, s.token))).toEqual([
        ids.rice,
      ]);
      expect(idsOf(await list({ commodity: rice.id }, s.token))).toEqual([
        ids.rice,
      ]);
      expect(idsOf(await list({ status: 'cancelled' }, s.token))).toEqual([
        ids.cancelled,
      ]);
      expect(
        idsOf(await list({ status: 'posted', buyer: s.beopari.id }, s.token)),
      ).toEqual([ids.today, ids.old]);
    });

    it('search by bill number or beopari name; sort by bill number', async () => {
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
      await list({ buyer: 'bashir' }, s.token).expect(400);
    });

    it('every role of the shop can read', async () => {
      const operator = await fx.user('operator', s.shop);
      const opToken = await login(operator.phone);
      await list({}, opToken).expect(200);
      await get(ids.today, opToken).expect(200);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /sales/:id', () => {
    it('400 for an id that is not a uuid, 404 for an unknown one', async () => {
      await get('not-a-uuid').expect(400);
      await get(UNKNOWN_ID).expect(404);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('PATCH /sales/:id', () => {
    it('edit weight: totals and khata corrected, audit shows the old values', async () => {
      const b = await trader();
      const s = await created({ buyerId: b.id });

      const res = await patch(
        s.id,
        { items: [item({ weightKg: '1200' })] },
        tokens.manager,
      ).expect(200);
      const edited = res.body as SavedSale;

      expect(edited).toMatchObject({
        id: s.id,
        billNo: s.billNo,
        grossAmount: '120000.00',
        totalCharges: '3200.00',
        netAmount: '123200.00',
        warnings: [],
      });
      expect(await balance(b.id)).toBe('123200.00');
      // Append-only: the old line, its reversal, the new line.
      expect(
        (await entriesOf(s.id)).map((e) => [e.sourceType, e.debit, e.credit]),
      ).toEqual([
        ['sale', '102700.00', '0.00'],
        ['reversal', '0.00', '102700.00'],
        ['sale', '123200.00', '0.00'],
      ]);

      const audit = await fx.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.tenantId, shopA),
            eq(auditLogs.action, 'update'),
            eq(auditLogs.entity, 'sales'),
            eq(auditLogs.entityId, s.id),
          ),
        );
      expect(audit).toHaveLength(1);
      expect(audit[0].before).toMatchObject({
        grossAmount: '100000.00',
        netAmount: '102700.00',
      });
      expect(audit[0].after).toMatchObject({ netAmount: '123200.00' });
      const oldItem = await fx.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entity, 'sale_items'),
            eq(auditLogs.entityId, s.items[0].id),
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
      const sale = (await saveIn(s).expect(201)).body as SavedSale;
      await fx.db
        .update(tenantSettings)
        .set({ defaultCommissionPct: '5' })
        .where(eq(tenantSettings.tenantId, s.shop));

      const kept = await patch(
        sale.id,
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
        sale.id,
        { charges: { commissionPct: null } },
        s.token,
      ).expect(200);
      expect(reset.body.charges[0]).toMatchObject({
        value: '5.00',
        amount: '10000.00',
      });
      expect(reset.body.netAmount).toBe('210000.00');
    });

    it('moving the sale to another beopari moves the debit', async () => {
      const a = await trader();
      const b = await trader();
      const s = await created({ buyerId: a.id });

      await patch(s.id, { buyerId: b.id }).expect(200);

      expect(await balance(a.id)).toBe('0.00');
      expect(await balance(b.id)).toBe('102700.00');
      const kissan = await trader({ type: 'kissan' });
      const res = await patch(s.id, { buyerId: kissan.id }).expect(400);
      expect(res.body.errors[0].field).toBe('buyerId');
    });

    it('receiving later on the same bill, and notes without a khata change', async () => {
      const b = await trader();
      const s = await created({ buyerId: b.id });

      await patch(s.id, { receivedAmount: '50000' }).expect(200);
      expect(await balance(b.id)).toBe('52700.00');
      const before = (await entriesOf(s.id)).length;

      const res = await patch(s.id, { notes: 'Checked' }).expect(200);
      expect(res.body.notes).toBe('Checked');
      expect(await entriesOf(s.id)).toHaveLength(before);

      await patch(s.id, {}).expect(200);
      await patch(s.id, { receivedAmount: '102700.01' }).expect(400);
    });

    it('operator cannot edit (403), not even today', async () => {
      const s = await created({}, tokens.operator);
      await patch(s.id, { notes: 'x' }, tokens.operator).expect(403);
    });

    it('manager: a closed day (before today) → 403 DAY_CLOSED; owner can always edit', async () => {
      const old = await created({ saleDate: YESTERDAY });
      const todays = await created();

      const res = await patch(
        old.id,
        { items: [item({ weightKg: '900' })] },
        tokens.manager,
      ).expect(403);
      expect(res.body).toMatchObject({ statusCode: 403, code: 'DAY_CLOSED' });
      await patch(todays.id, { saleDate: YESTERDAY }, tokens.manager).expect(
        403,
      );

      const owner = await patch(
        old.id,
        { items: [item({ weightKg: '900' })] },
        tokens.ownerA,
      ).expect(200);
      expect(owner.body.grossAmount).toBe('90000.00');
      // The correction sits on the sale's own day.
      expect((await entriesOf(old.id)).map((e) => e.entryDate)).toEqual([
        YESTERDAY,
        YESTERDAY,
        YESTERDAY,
      ]);
    });

    it('400 for an inactive commodity added, but one already on the bill may stay', async () => {
      const c = await commodity();
      const s = await created({ items: [item({ commodityId: c.id })] });
      await as(http().patch(`/commodities/${c.id}`), tokens.ownerA)
        .send({ isActive: false })
        .expect(200);

      await patch(s.id, {
        items: [item({ commodityId: c.id, weightKg: '500' })],
      }).expect(200);
      const off = await commodity({ isActive: false });
      const res = await patch(s.id, {
        items: [item({ commodityId: off.id })],
      }).expect(400);
      expect(res.body.errors[0].field).toBe('items.0.commodityId');
    });

    it('409 for a cancelled sale; 404 unknown', async () => {
      const s = await created();
      await cancel(s.id).expect(200);
      const res = await patch(s.id, { notes: 'x' }).expect(409);
      expect(res.body.code).toBe('SALE_CANCELLED');
      await patch(UNKNOWN_ID, { notes: 'x' }).expect(404);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('POST /sales/:id/cancel', () => {
    it('reverses the khata, marks the bill cancelled, the number is not reused', async () => {
      const s = await freshShop();
      const sale = (await saveIn(s, { receivedAmount: '30000' }).expect(201))
        .body as SavedSale;

      const res = await cancel(sale.id, s.token).expect(200);

      expect(res.body).toMatchObject({
        id: sale.id,
        billNo: bill(1),
        status: 'cancelled',
        netAmount: '100000.00',
      });
      expect(res.body).not.toHaveProperty('warnings');
      expect(res.body.items).toHaveLength(1);
      expect(await balance(s.beopari.id, s.token)).toBe('0.00');
      expect((await entriesOf(sale.id)).map((e) => e.sourceType)).toEqual([
        'sale',
        'sale',
        'reversal',
      ]);
      const next = await saveIn(s).expect(201);
      expect(next.body.billNo).toBe(bill(2));
      // Still there to read.
      await get(sale.id, s.token).expect(200);
    });

    it('twice → 409; nothing more reversed', async () => {
      const s = await created();
      await cancel(s.id).expect(200);
      const res = await cancel(s.id).expect(409);
      expect(res.body.code).toBe('SALE_CANCELLED');
      expect(await entriesOf(s.id)).toHaveLength(2);
    });

    it('only the owner can cancel (manager, operator → 403)', async () => {
      const s = await created();
      await cancel(s.id, tokens.manager).expect(403);
      await cancel(s.id, tokens.operator).expect(403);
      expect((await get(s.id).expect(200)).body.status).toBe('posted');
    });

    it('404 for an unknown id', async () => {
      await cancel(UNKNOWN_ID).expect(404);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('permissions', () => {
    it('operator: create and view; no edit or cancel', async () => {
      const s = await created({}, tokens.operator);
      await get(s.id, tokens.operator).expect(200);
      await list({}, tokens.operator).expect(200);
      await patch(s.id, { notes: 'x' }, tokens.operator).expect(403);
      await cancel(s.id, tokens.operator).expect(403);
    });

    it('manager: create, view and edit; no cancel', async () => {
      const s = await created({}, tokens.manager);
      await patch(s.id, { notes: 'x' }, tokens.manager).expect(200);
      await cancel(s.id, tokens.manager).expect(403);
    });

    it('signed out → 401', async () => {
      await create({}, null).expect(401);
      await list({}, null).expect(401);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('a commodity on a sale cannot be deleted', () => {
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
  describe('reconciliation: sale totals equal the khata', () => {
    it('passes after creates, receipts, edits and cancels', async () => {
      const s = await freshShop();
      const b2 = await trader({}, s.token);
      const a = (await saveIn(s).expect(201)).body as SavedSale;
      const b = (await saveIn(s, { receivedAmount: '1000' }).expect(201))
        .body as SavedSale;
      const c = (await saveIn(s).expect(201)).body as SavedSale;
      await patch(
        a.id,
        { items: [item({ commodityId: s.wheat.id, weightKg: '1500' })] },
        s.token,
      ).expect(200);
      await patch(
        b.id,
        { buyerId: b2.id, receivedAmount: '2000' },
        s.token,
      ).expect(200);
      await cancel(c.id, s.token).expect(200);

      const result = await app.get(LedgerReconciliation).run([s.shop]);

      expect(result.mismatches).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it('alerts when a sale and its khata differ', async () => {
      const s = await freshShop();
      const sale = (await saveIn(s).expect(201)).body as SavedSale;
      // Changed around the service, as the table owner.
      await fx.db
        .update(sales)
        .set({ netAmount: '99999.00' })
        .where(eq(sales.id, sale.id));
      const alert = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      try {
        const result = await app.get(LedgerReconciliation).run([s.shop]);
        expect(result.mismatches).toEqual([
          {
            check: 'document',
            tenantId: s.shop,
            traderId: s.beopari.id,
            sourceType: 'sale',
            sourceId: sale.id,
            entryDate: null,
            expected: '99999.00',
            actual: '100000.00',
          },
        ]);
      } finally {
        alert.mockRestore();
      }
    });
  });

  /* ---------------------------------------------------------------- */
  describe('multi-tenant isolation', () => {
    let s: SavedSale;

    beforeAll(async () => {
      const p = await purchase([item()]);
      s = await created({
        receivedAmount: '100',
        items: [item({ purchaseItemId: p.items[0].id })],
      });
    });

    it('shop B’s list never has shop A’s sales', async () => {
      const res = await list({}, tokens.ownerB).expect(200);
      expect(res.body.data.map((x: SaleSummary) => x.id)).not.toContain(s.id);
      const filtered = await list({ buyer: beopari.id }, tokens.ownerB).expect(
        200,
      );
      expect(filtered.body.meta.total).toBe(0);
      const byCommodity = await list(
        { commodity: wheat.id },
        tokens.ownerB,
      ).expect(200);
      expect(byCommodity.body.meta.total).toBe(0);
    });

    it('shop B cannot read, edit or cancel shop A’s sale (404, not 403)', async () => {
      await get(s.id, tokens.ownerB).expect(404);
      await patch(s.id, { notes: 'hacked' }, tokens.ownerB).expect(404);
      await cancel(s.id, tokens.ownerB).expect(404);

      const after = await get(s.id).expect(200);
      expect(after.body).toEqual(withoutWarnings(s));
      expect(await entriesOf(s.id)).toHaveLength(2);
    });

    it('shop B cannot sell to shop A’s beopari, use its lot, or replay its key', async () => {
      const key = randomUUID();
      await create({}, tokens.ownerA, key).expect(201);
      const res = await create(
        { items: [item({ purchaseItemId: s.items[0].purchaseItemId })] },
        tokens.ownerB,
        key,
      ).expect(400);
      expect(res.body.errors).toEqual([
        { field: 'buyerId', message: 'Beopari not found' },
        { field: 'items.0.commodityId', message: 'Commodity not found' },
        { field: 'items.0.purchaseItemId', message: 'Lot not found' },
      ]);
    });

    it('row-level security: shop B’s role sees no shop A rows even by raw query', async () => {
      const seen = await fx.db.transaction(async (tx) => {
        await tx.execute(sql`set local role app_tenant`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${shopB}, true)`,
        );
        const r = await tx.execute(
          sql`select (select count(*) from sales where id = ${s.id})::int as s,
                     (select count(*) from sale_items where sale_id = ${s.id})::int as i,
                     (select count(*) from sale_charges where sale_id = ${s.id})::int as c`,
        );
        return r.rows[0];
      });
      expect(seen).toEqual({ s: 0, i: 0, c: 0 });
    });
  });
});
