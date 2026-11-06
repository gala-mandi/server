import { randomUUID } from 'node:crypto';
import { INestApplication, Logger, NotFoundException } from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import { and, asc, eq } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { App } from 'supertest/types';
import type { RequestContext } from '../src/common/context/request-context';
import {
  auditLogs,
  ledgerDailyBalances,
  ledgerEntries,
} from '../src/database/schema';
import {
  TenantDatabase,
  type TenantScope,
} from '../src/database/tenant-database';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import type { LedgerEntry } from '../src/modules/ledger/ledger.dto';
import { InvalidEntryError } from '../src/modules/ledger/ledger-math';
import { LedgerReconciliation } from '../src/modules/ledger/ledger-reconciliation.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { shopDate } from '../src/modules/numbering/bill-number';
import type { Trader } from '../src/modules/traders/traders.dto';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const STATEMENT_BUDGET_MS = 300;
// Page 400 of a whole 50k khata walks 40k entries first (not a ticket scenario).
const DEEP_PAGE_BUDGET_MS = 500;
const PERF_ENTRIES = 50_000;

type Token = 'ownerA' | 'ownerB' | 'manager' | 'operator' | 'superAdmin';

describe('Ledger /ledger (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;
  let ledger: LedgerService;
  let reconciliation: LedgerReconciliation;

  let shopA: string;
  let shopB: string;
  const users = {} as Record<'ownerA' | 'ownerB', string>;
  const tokens = {} as Record<Token, string>;

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string | null) =>
    token ? req.set('Authorization', `Bearer ${token}`) : req;

  const statement = (
    token: string | null,
    traderId: string,
    query: Record<string, unknown> = {},
  ) => as(http().get(`/ledger/${traderId}`), token).query(query);
  const balances = (
    token: string | null,
    query: Record<string, unknown> = {},
  ) => as(http().get('/ledger/balances'), token).query(query);
  const adjust = (token: string | null, body: object) =>
    as(http().post('/ledger/adjustments'), token).send(body);

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

  /** A trader made through the API (owner A's shop by default). */
  async function trader(
    body: Record<string, unknown> = {},
    token = tokens.ownerA,
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

  /**
   * Runs `fn` the way purchases, sales and payments will: inside a shop's
   * transaction (outside HTTP, so the shop is set here).
   */
  function inShop<R>(
    tenantId: string,
    fn: (scope: TenantScope) => Promise<R>,
  ): Promise<R> {
    const cls = app.get<ClsService<RequestContext>>(ClsService);
    return cls.run(() => {
      cls.set('tenantId', tenantId);
      if (tenantId === shopA) cls.set('userId', users.ownerA);
      if (tenantId === shopB) cls.set('userId', users.ownerB);
      return app.get(TenantDatabase).transaction(fn);
    });
  }

  /** Posts one entry through LedgerService in shop A. */
  const post = (
    traderId: string,
    entry: Partial<Parameters<LedgerService['post']>[1]> = {},
    tenantId = shopA,
  ) =>
    inShop(tenantId, (scope) =>
      ledger.post(scope, {
        traderId,
        sourceType: 'purchase',
        sourceId: randomUUID(),
        credit: '100.00',
        entryDate: '2026-10-15',
        userId: null,
        ...entry,
      }),
    );

  const entriesOf = (traderId: string) =>
    fx.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.traderId, traderId))
      .orderBy(asc(ledgerEntries.id));

  beforeAll(async () => {
    fx = new Fixtures();
    app = await createTestApp({
      override: (builder) =>
        builder
          .overrideProvider(OTP_SENDER)
          .useValue({ send: () => Promise.resolve() }),
    });
    ledger = app.get(LedgerService);
    reconciliation = app.get(LedgerReconciliation);

    shopA = await fx.tenant();
    shopB = await fx.tenant();
    const ownerA = await fx.user('owner', shopA);
    const ownerB = await fx.user('owner', shopB);
    const manager = await fx.user('manager', shopA);
    const operator = await fx.user('operator', shopA);
    const superAdmin = await fx.user('super_admin', null);
    users.ownerA = ownerA.id;
    users.ownerB = ownerB.id;

    tokens.ownerA = await login(ownerA.phone);
    tokens.ownerB = await login(ownerB.phone);
    tokens.manager = await login(manager.phone);
    tokens.operator = await login(operator.phone);
    tokens.superAdmin = await login(superAdmin.phone);
  });

  beforeEach(() => resetThrottle());

  afterAll(async () => {
    await app.close();
    // Khata, snapshots, traders and audit rows go with the shops.
    await fx.cleanup();
  });

  /* ---------------------------------------------------------------- */
  describe('LedgerService (used by purchases, sales, payments)', () => {
    it('purchase Rs 100,000 credits the kissan; payment Rs 40,000 leaves 60,000 payable', async () => {
      const kissan = await trader();
      const purchaseId = randomUUID();
      const paymentId = randomUUID();

      const purchase = await post(kissan.id, {
        sourceId: purchaseId,
        credit: '100000',
        narration: 'Purchase PUR-2026-27-000001',
        entryDate: '2026-10-10',
      });
      await post(kissan.id, {
        sourceType: 'payment',
        sourceId: paymentId,
        debit: '40000',
        credit: undefined,
        narration: 'Payment PAY-2026-27-000001',
        entryDate: '2026-10-12',
      });

      expect(purchase).toEqual({
        id: expect.any(Number),
        traderId: kissan.id,
        entryDate: '2026-10-10',
        sourceType: 'purchase',
        sourceId: purchaseId,
        debit: '0.00',
        credit: '100000.00',
        narration: 'Purchase PUR-2026-27-000001',
        createdBy: null,
        createdAt: expect.stringMatching(ISO),
      });
      const res = await statement(tokens.ownerA, kissan.id).expect(200);
      expect(res.body.closingBalance).toBe('-60000.00');
      const all = await balances(tokens.ownerA, {
        search: kissan.name,
      }).expect(200);
      expect(all.body.data).toEqual([
        expect.objectContaining({
          traderId: kissan.id,
          balance: '-60000.00',
          receivable: '0.00',
          payable: '60000.00',
        }),
      ]);
    });

    it('cancelled purchase: reversal entry brings the balance back to before', async () => {
      const kissan = await trader({
        openingBalance: '5000',
        openingBalanceType: 'credit',
      });
      const purchaseId = randomUUID();
      await post(kissan.id, { sourceId: purchaseId, credit: '100000' });

      const reversed = await inShop(shopA, (scope) =>
        ledger.reverse(scope, {
          sourceType: 'purchase',
          sourceId: purchaseId,
          narration: 'Purchase PUR-2026-27-000002 cancelled',
          userId: users.ownerA,
        }),
      );

      expect(reversed).toEqual([
        expect.objectContaining({
          traderId: kissan.id,
          sourceType: 'reversal',
          sourceId: purchaseId,
          debit: '100000.00',
          credit: '0.00',
          narration: 'Purchase PUR-2026-27-000002 cancelled',
          entryDate: shopDate(new Date()),
          createdBy: users.ownerA,
        }),
      ]);
      const res = await statement(tokens.ownerA, kissan.id).expect(200);
      expect(res.body.closingBalance).toBe('-5000.00');
      // Nothing was changed or removed: purchase and reversal both stay.
      expect((await entriesOf(kissan.id)).map((e) => e.sourceType)).toEqual([
        'opening',
        'purchase',
        'reversal',
      ]);
    });

    it('reversing twice adds nothing the second time; other documents stay', async () => {
      const kissan = await trader();
      const cancelled = randomUUID();
      await post(kissan.id, { sourceId: cancelled, credit: '700' });
      await post(kissan.id, { sourceId: randomUUID(), credit: '300' });
      const cancel = () =>
        inShop(shopA, (scope) =>
          ledger.reverse(scope, {
            sourceType: 'purchase',
            sourceId: cancelled,
            narration: 'Cancelled',
            userId: null,
          }),
        );

      expect(await cancel()).toHaveLength(1);
      expect(await cancel()).toEqual([]);
      const res = await statement(tokens.ownerA, kissan.id).expect(200);
      expect(res.body.closingBalance).toBe('-300.00');
    });

    it('two cancels at the same time reverse once', async () => {
      const kissan = await trader();
      const purchaseId = randomUUID();
      await post(kissan.id, { sourceId: purchaseId, credit: '900' });
      const cancel = () =>
        inShop(shopA, (scope) =>
          ledger.reverse(scope, {
            sourceType: 'purchase',
            sourceId: purchaseId,
            narration: 'Cancelled',
            userId: null,
          }),
        );

      const results = await Promise.all([cancel(), cancel()]);

      expect(results.map((r) => r.length).sort()).toEqual([0, 1]);
      const res = await statement(tokens.ownerA, kissan.id).expect(200);
      expect(res.body.closingBalance).toBe('0.00');
    });

    it('a reversal of one document never touches another trader’s documents', async () => {
      const a = await trader();
      const b = await trader();
      await post(a.id, { sourceId: randomUUID(), credit: '100' });
      await post(b.id, { sourceId: randomUUID(), credit: '200' });

      expect(
        await inShop(shopA, (scope) =>
          ledger.reverse(scope, {
            sourceType: 'purchase',
            sourceId: randomUUID(),
            narration: 'Nothing',
            userId: null,
          }),
        ),
      ).toEqual([]);
      expect(await entriesOf(a.id)).toHaveLength(1);
      expect(await entriesOf(b.id)).toHaveLength(1);
    });

    it('saves with the document or not at all (the caller’s transaction)', async () => {
      const kissan = await trader();

      await expect(
        inShop(shopA, async (scope) => {
          await ledger.post(scope, {
            traderId: kissan.id,
            sourceType: 'purchase',
            sourceId: randomUUID(),
            credit: '100',
            userId: null,
          });
          throw new Error('purchase save failed');
        }),
      ).rejects.toThrow('purchase save failed');

      expect(await entriesOf(kissan.id)).toEqual([]);
      const snapshots = await fx.db
        .select()
        .from(ledgerDailyBalances)
        .where(eq(ledgerDailyBalances.traderId, kissan.id));
      expect(snapshots).toEqual([]);
    });

    it('refuses a trader of another shop, an unknown or deleted trader', async () => {
      const ofB = await trader({}, tokens.ownerB);
      const deleted = await trader();
      await as(http().delete(`/traders/${deleted.id}`), tokens.ownerA).expect(
        204,
      );

      for (const id of [ofB.id, UNKNOWN_ID, deleted.id]) {
        await expect(post(id)).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(await entriesOf(ofB.id)).toEqual([]);
    });

    it('refuses amounts that are not one positive side', async () => {
      const kissan = await trader();

      await expect(post(kissan.id, { credit: '0' })).rejects.toBeInstanceOf(
        InvalidEntryError,
      );
      await expect(
        post(kissan.id, { debit: '10', credit: '10' }),
      ).rejects.toBeInstanceOf(InvalidEntryError);
      await expect(post(kissan.id, { credit: '-5' })).rejects.toBeInstanceOf(
        InvalidEntryError,
      );
      expect(await entriesOf(kissan.id)).toEqual([]);
    });

    it('writes an audit row for every entry', async () => {
      const kissan = await trader();
      const entry = await post(kissan.id, { credit: '42' });

      const rows = await fx.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entity, 'ledger_entries'),
            eq(auditLogs.entityId, kissan.id),
          ),
        );
      expect(rows).toEqual([
        expect.objectContaining({
          tenantId: shopA,
          userId: users.ownerA,
          action: 'create',
          after: expect.objectContaining({ id: entry.id, credit: '42.00' }),
        }),
      ]);
    });

    it('balance() as of a date', async () => {
      const kissan = await trader();
      await post(kissan.id, { credit: '100', entryDate: '2026-09-01' });
      await post(kissan.id, {
        debit: '30',
        credit: undefined,
        entryDate: '2026-09-05',
      });

      const at = (date?: string) =>
        inShop(shopA, (scope) => ledger.balance(scope, kissan.id, date));
      expect(await at('2026-08-31')).toBe('0.00');
      expect(await at('2026-09-01')).toBe('-100.00');
      expect(await at()).toBe('-70.00');
    });
  });

  /* ---------------------------------------------------------------- */
  describe('append-only', () => {
    /** Runs SQL as the API runs it in shop A (app_tenant, RLS on). */
    async function asApp(query: string, params: unknown[] = []) {
      const client = await fx.pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role app_tenant');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [
          shopA,
        ]);
        return await client.query(query, params);
      } finally {
        await client.query('rollback');
        client.release();
      }
    }

    it('the API role cannot update or delete entries', async () => {
      const kissan = await trader();
      const entry = await post(kissan.id);

      await expect(
        asApp(`update ledger_entries set credit = 1 where id = $1`, [entry.id]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asApp(`delete from ledger_entries where id = $1`, [entry.id]),
      ).rejects.toThrow(/permission denied/);
      await expect(asApp(`truncate ledger_entries`)).rejects.toThrow(
        /permission denied/,
      );
      expect(await entriesOf(kissan.id)).toHaveLength(1);
    });

    it('the API role can only read the daily snapshots', async () => {
      const kissan = await trader();
      await post(kissan.id);

      const { rows } = await asApp(
        `select debit, credit from ledger_daily_balances where trader_id = $1`,
        [kissan.id],
      );
      expect(rows).toEqual([{ debit: '0.00', credit: '100.00' }]);
      await expect(
        asApp(`update ledger_daily_balances set credit = 0`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asApp(
          `insert into ledger_daily_balances (tenant_id, trader_id, entry_date) values ($1, $2, '2026-01-01')`,
          [shopA, kissan.id],
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /ledger/:traderId', () => {
    let kissan: Trader;

    beforeAll(async () => {
      // Opening Rs 25,000 payable, entered on the day the trader was added.
      kissan = await trader({
        openingBalance: '25000',
        openingBalanceType: 'credit',
      });
      // September (before "last month") and October ("last month").
      await post(kissan.id, { credit: '10000', entryDate: '2026-09-20' });
      await post(kissan.id, {
        sourceType: 'payment',
        debit: '5000',
        credit: undefined,
        entryDate: '2026-09-25',
      });
      await post(kissan.id, { credit: '100000', entryDate: '2026-10-03' });
      await post(kissan.id, {
        sourceType: 'payment',
        debit: '40000',
        credit: undefined,
        entryDate: '2026-10-03',
      });
      await post(kissan.id, {
        sourceType: 'payment',
        debit: '20000.50',
        credit: undefined,
        entryDate: '2026-10-28',
      });
    });

    it('statement for last month: opening balance carried from before', async () => {
      const res = await statement(tokens.ownerA, kissan.id, {
        from: '2026-10-01',
        to: '2026-10-31',
      }).expect(200);

      expect(res.body).toEqual({
        trader: { id: kissan.id, type: 'kissan', name: kissan.name },
        from: '2026-10-01',
        to: '2026-10-31',
        // September only: the opening entry is dated today (November).
        openingBalance: '-5000.00',
        closingBalance: '-44999.50',
        data: [
          expect.objectContaining({
            entryDate: '2026-10-03',
            sourceType: 'purchase',
            debit: '0.00',
            credit: '100000.00',
            balance: '-105000.00',
          }),
          expect.objectContaining({
            entryDate: '2026-10-03',
            sourceType: 'payment',
            debit: '40000.00',
            balance: '-65000.00',
          }),
          expect.objectContaining({
            entryDate: '2026-10-28',
            debit: '20000.50',
            balance: '-44999.50',
          }),
        ],
        meta: { page: 1, limit: 100, total: 3 },
      });
    });

    it('without dates: the whole khata from 0, in date order', async () => {
      const res = await statement(tokens.ownerA, kissan.id).expect(200);

      expect(res.body.openingBalance).toBe('0.00');
      expect(res.body.from).toBeNull();
      expect(res.body.to).toBeNull();
      expect(
        (res.body.data as (LedgerEntry & { balance: string })[]).map((e) => [
          e.entryDate,
          e.sourceType,
          e.balance,
        ]),
      ).toEqual([
        ['2026-09-20', 'purchase', '-10000.00'],
        ['2026-09-25', 'payment', '-5000.00'],
        ['2026-10-03', 'purchase', '-105000.00'],
        ['2026-10-03', 'payment', '-65000.00'],
        ['2026-10-28', 'payment', '-44999.50'],
        [shopDate(new Date()), 'opening', '-69999.50'],
      ]);
      expect(res.body.closingBalance).toBe('-69999.50');
    });

    it('only `from` or only `to`', async () => {
      const fromOct = await statement(tokens.ownerA, kissan.id, {
        from: '2026-10-28',
      }).expect(200);
      expect(fromOct.body.openingBalance).toBe('-65000.00');
      expect(fromOct.body.closingBalance).toBe('-69999.50');
      expect(fromOct.body.meta.total).toBe(2);

      const toSep = await statement(tokens.ownerA, kissan.id, {
        to: '2026-09-30',
      }).expect(200);
      expect(toSep.body.openingBalance).toBe('0.00');
      expect(toSep.body.closingBalance).toBe('-5000.00');
      expect(toSep.body.meta.total).toBe(2);
    });

    it('an empty range still has opening and closing balance', async () => {
      const res = await statement(tokens.ownerA, kissan.id, {
        from: '2026-10-04',
        to: '2026-10-27',
      }).expect(200);

      expect(res.body).toMatchObject({
        openingBalance: '-65000.00',
        closingBalance: '-65000.00',
        data: [],
        meta: { total: 0 },
      });
    });

    it('page 2 continues the running balance of page 1', async () => {
      const page1 = await statement(tokens.ownerA, kissan.id, {
        limit: 4,
      }).expect(200);
      const page2 = await statement(tokens.ownerA, kissan.id, {
        limit: 4,
        page: 2,
      }).expect(200);

      expect(page1.body.data).toHaveLength(4);
      expect(page1.body.data[3].balance).toBe('-65000.00');
      expect(
        (page2.body.data as { balance: string }[]).map((e) => e.balance),
      ).toEqual(['-44999.50', '-69999.50']);
      // Opening and closing are the range's, not the page's.
      expect(page2.body.openingBalance).toBe('0.00');
      expect(page2.body.closingBalance).toBe('-69999.50');
      expect(page2.body.meta).toEqual({ page: 2, limit: 4, total: 6 });
    });

    it('every balance can be traced to its entries', async () => {
      const res = await statement(tokens.ownerA, kissan.id).expect(200);
      const rows = await entriesOf(kissan.id);

      expect((res.body.data as LedgerEntry[]).map((e) => e.id).sort()).toEqual(
        rows.map((r) => r.id).sort(),
      );
    });

    it.each([
      [{ from: '2026-11-01', to: '2026-10-01' }],
      [{ from: '2026-02-30' }],
      [{ to: 'last-month' }],
      [{ limit: 0 }],
      [{ page: 0 }],
    ])('400 for %o', async (query) => {
      await statement(tokens.ownerA, kissan.id, query).expect(400);
    });

    it('400 for an id that is not a uuid', async () => {
      await statement(tokens.ownerA, 'balance').expect(400);
    });

    it('404 for an unknown or deleted trader', async () => {
      await statement(tokens.ownerA, UNKNOWN_ID).expect(404);
      const gone = await trader();
      await as(http().delete(`/traders/${gone.id}`), tokens.ownerA).expect(204);
      await statement(tokens.ownerA, gone.id).expect(404);
    });

    it.each<[Token | null, number]>([
      ['ownerA', 200],
      ['manager', 200],
      ['operator', 403],
      ['superAdmin', 403],
      [null, 401],
    ])('%s gets %i', async (who, status) => {
      await statement(who && tokens[who], kissan.id).expect(status);
    });

    it('shop B never sees shop A’s khata (404, not 403)', async () => {
      const res = await statement(tokens.ownerB, kissan.id).expect(404);
      expect(res.body.message).toBe('Trader not found');
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /ledger/balances', () => {
    let shop: string;
    let token: string;
    let kissan: Trader;
    let beopari: Trader;
    let settled: Trader;

    beforeAll(async () => {
      // A shop of its own, so totals are exact.
      shop = await fx.tenant();
      const owner = await fx.user('owner', shop);
      token = await login(owner.phone);
      kissan = await trader({ name: 'Akram Kissan' }, token);
      beopari = await trader(
        { type: 'beopari', name: 'Bashir Beopari', openingBalance: '1500.25' },
        token,
      );
      settled = await trader({ name: 'Chaudhry Settled' }, token);
      await post(kissan.id, { credit: '100000' }, shop);
      await post(
        kissan.id,
        { sourceType: 'payment', debit: '40000', credit: undefined },
        shop,
      );
      await post(
        beopari.id,
        { sourceType: 'sale', debit: '75000', credit: undefined },
        shop,
      );
    });

    it('every trader with receivable or payable, and the shop totals', async () => {
      const res = await balances(token).expect(200);

      expect(res.body).toEqual({
        data: [
          {
            traderId: kissan.id,
            type: 'kissan',
            name: 'Akram Kissan',
            phone: null,
            balance: '-60000.00',
            receivable: '0.00',
            payable: '60000.00',
          },
          {
            traderId: beopari.id,
            type: 'beopari',
            name: 'Bashir Beopari',
            phone: null,
            balance: '76500.25',
            receivable: '76500.25',
            payable: '0.00',
          },
          {
            traderId: settled.id,
            type: 'kissan',
            name: 'Chaudhry Settled',
            phone: null,
            balance: '0.00',
            receivable: '0.00',
            payable: '0.00',
          },
        ],
        totals: { receivable: '76500.25', payable: '60000.00' },
        meta: { page: 1, limit: 20, total: 3 },
      });
    });

    it('filters by type and search; totals follow the filter', async () => {
      const kissans = await balances(token, { type: 'kissan' }).expect(200);
      expect(kissans.body.meta.total).toBe(2);
      expect(kissans.body.totals).toEqual({
        receivable: '0.00',
        payable: '60000.00',
      });

      const found = await balances(token, { search: 'bashir' }).expect(200);
      expect(found.body.data.map((t: { name: string }) => t.name)).toEqual([
        'Bashir Beopari',
      ]);
    });

    it('sorts by balance and pages', async () => {
      const byBalance = await balances(token, { sort: '-balance' }).expect(200);
      expect(
        byBalance.body.data.map((t: { balance: string }) => t.balance),
      ).toEqual(['76500.25', '0.00', '-60000.00']);

      const page2 = await balances(token, { limit: 2, page: 2 }).expect(200);
      expect(page2.body.data.map((t: { name: string }) => t.name)).toEqual([
        'Chaudhry Settled',
      ]);
      expect(page2.body.meta).toEqual({ page: 2, limit: 2, total: 3 });
      // Totals are the whole list's, not the page's.
      expect(page2.body.totals.payable).toBe('60000.00');
    });

    it('leaves out deleted traders', async () => {
      const gone = await trader({ name: 'Zafar Gone' }, token);
      await as(http().delete(`/traders/${gone.id}`), token).expect(204);

      const res = await balances(token, { search: 'zafar' }).expect(200);
      expect(res.body.data).toEqual([]);
    });

    it('400 for an unknown sort or type', async () => {
      await balances(token, { sort: 'phone' }).expect(400);
      await balances(token, { type: 'bank' }).expect(400);
    });

    it.each<[Token | null, number]>([
      ['ownerA', 200],
      ['manager', 200],
      ['operator', 403],
      ['superAdmin', 403],
      [null, 401],
    ])('%s gets %i', async (who, status) => {
      await balances(who && tokens[who]).expect(status);
    });

    it('each shop sees only its own traders and entries', async () => {
      const ofB = await balances(tokens.ownerB, { limit: 100 }).expect(200);
      const ids = (ofB.body.data as { traderId: string }[]).map(
        (t) => t.traderId,
      );

      for (const id of [kissan.id, beopari.id, settled.id]) {
        expect(ids).not.toContain(id);
      }
      const ofShop = await balances(token, { limit: 100 }).expect(200);
      expect(ofShop.body.meta.total).toBe(3);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('POST /ledger/adjustments', () => {
    let kissan: Trader;
    const valid = () => ({
      traderId: kissan.id,
      side: 'debit',
      amount: '250.75',
      reason: 'Bardana charge missed on parchi 17',
      entryDate: '2026-10-20',
    });

    beforeAll(async () => {
      kissan = await trader();
      await post(kissan.id, { credit: '1000', entryDate: '2026-10-01' });
    });

    it('owner adds an adjustment entry; the reason is its narration', async () => {
      const res = await adjust(tokens.ownerA, valid()).expect(201);

      expect(res.body).toEqual({
        id: expect.any(Number),
        traderId: kissan.id,
        entryDate: '2026-10-20',
        sourceType: 'adjustment',
        sourceId: null,
        debit: '250.75',
        credit: '0.00',
        narration: 'Bardana charge missed on parchi 17',
        createdBy: users.ownerA,
        createdAt: expect.stringMatching(ISO),
      });
      const after = await statement(tokens.ownerA, kissan.id).expect(200);
      expect(after.body.closingBalance).toBe('-749.25');
    });

    it('a credit adjustment dated today by default', async () => {
      const res = await adjust(tokens.ownerA, {
        traderId: kissan.id,
        side: 'credit',
        amount: '0.25',
        reason: 'Rounding',
      }).expect(201);

      expect(res.body).toMatchObject({
        entryDate: shopDate(new Date()),
        debit: '0.00',
        credit: '0.25',
      });
    });

    it.each([
      ['no reason', { reason: undefined }],
      ['a blank reason', { reason: '  ' }],
      ['amount 0', { amount: '0' }],
      ['a negative amount', { amount: '-10' }],
      ['3 decimals', { amount: '1.005' }],
      ['no side', { side: undefined }],
      ['a future date', { entryDate: '2999-01-01' }],
      ['a bad date', { entryDate: '2026-02-30' }],
    ])('400 for %s', async (_, over) => {
      const before = (await entriesOf(kissan.id)).length;

      await adjust(tokens.ownerA, { ...valid(), ...over }).expect(400);

      expect(await entriesOf(kissan.id)).toHaveLength(before);
    });

    it('names the field when the reason is missing', async () => {
      const res = await adjust(tokens.ownerA, {
        ...valid(),
        reason: undefined,
      }).expect(400);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'reason' })]),
      );
    });

    it.each<[Token | null, number]>([
      ['manager', 403],
      ['operator', 403],
      ['superAdmin', 403],
      [null, 401],
    ])('%s gets %i and nothing is written', async (who, status) => {
      const before = (await entriesOf(kissan.id)).length;

      await adjust(who && tokens[who], valid()).expect(status);

      expect(await entriesOf(kissan.id)).toHaveLength(before);
    });

    it('404 for an unknown trader', async () => {
      await adjust(tokens.ownerA, { ...valid(), traderId: UNKNOWN_ID }).expect(
        404,
      );
    });

    it('shop B cannot adjust shop A’s trader (404, nothing written)', async () => {
      const before = (await entriesOf(kissan.id)).length;

      const res = await adjust(tokens.ownerB, valid()).expect(404);

      expect(res.body.message).toBe('Trader not found');
      expect(await entriesOf(kissan.id)).toHaveLength(before);
    });

    it('a tenant_id in the body is ignored', async () => {
      const ofB = await trader({}, tokens.ownerB);

      await adjust(tokens.ownerB, {
        ...valid(),
        traderId: ofB.id,
        tenant_id: shopA,
        tenantId: shopA,
      }).expect(201);

      const [row] = await entriesOf(ofB.id);
      expect(row.tenantId).toBe(shopB);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('reconciliation check', () => {
    let shop: string;
    let token: string;

    beforeAll(async () => {
      shop = await fx.tenant();
      const owner = await fx.user('owner', shop);
      token = await login(owner.phone);
    });

    it('passes when documents and khata agree (openings, edits, deletes, adjustments)', async () => {
      const a = await trader({ openingBalance: '5000' }, token);
      const b = await trader(
        { openingBalance: '700', openingBalanceType: 'credit' },
        token,
      );
      await trader({}, token);
      // Opening corrected twice: reversal + new opening each time.
      await as(http().patch(`/traders/${a.id}`), token)
        .send({ openingBalance: '6000' })
        .expect(200);
      await as(http().patch(`/traders/${a.id}`), token)
        .send({ openingBalanceType: 'credit' })
        .expect(200);
      await as(http().patch(`/traders/${b.id}`), token)
        .send({ openingBalance: '0' })
        .expect(200);
      await as(http().delete(`/traders/${b.id}`), token).expect(204);
      await adjust(token, {
        traderId: (await trader({}, token)).id,
        side: 'debit',
        amount: '10',
        reason: 'Test adjustment',
      }).expect(201);

      const result = await reconciliation.run([shop]);

      expect(result).toEqual({
        ok: true,
        checkedAt: expect.stringMatching(ISO),
        mismatches: [],
      });
    });

    it('alerts when the khata and a document differ', async () => {
      const a = await trader({ openingBalance: '5000' }, token);
      // An opening entry no edit of the trader explains (written around the
      // service, as the table owner).
      await fx.db.insert(ledgerEntries).values({
        tenantId: shop,
        traderId: a.id,
        entryDate: '2026-10-01',
        sourceType: 'opening',
        sourceId: a.id,
        debit: '1.00',
      });
      const alert = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      try {
        const result = await reconciliation.run([shop]);

        expect(result.ok).toBe(false);
        expect(result.mismatches).toEqual([
          {
            check: 'document',
            tenantId: shop,
            traderId: a.id,
            sourceType: 'opening',
            sourceId: a.id,
            entryDate: null,
            expected: '5000.00',
            actual: '5001.00',
          },
        ]);
        expect(alert).toHaveBeenCalledWith(
          expect.objectContaining({ count: 1 }),
          'Ledger reconciliation found 1 mismatch(es)',
        );
      } finally {
        alert.mockRestore();
      }
    });

    it('flags entries no document explains and snapshots that differ', async () => {
      const other = await fx.tenant();
      const owner = await fx.user('owner', other);
      const otherToken = await login(owner.phone);
      const t = await trader({}, otherToken);
      const strayId = randomUUID();
      // Every document type is registered now: a reversal of a document
      // that never was is what no document explains.
      await fx.db.insert(ledgerEntries).values({
        tenantId: other,
        traderId: t.id,
        entryDate: '2026-10-02',
        sourceType: 'reversal',
        sourceId: strayId,
        credit: '300.00',
      });
      // A snapshot changed by hand.
      await fx.db
        .update(ledgerDailyBalances)
        .set({ credit: '299.00' })
        .where(eq(ledgerDailyBalances.traderId, t.id));
      const alert = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      try {
        const result = await reconciliation.run([other]);

        expect(result.mismatches).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              check: 'unexplained',
              traderId: t.id,
              sourceType: 'reversal',
              sourceId: strayId,
              actual: '-300.00',
            }),
            expect.objectContaining({
              check: 'daily_balance',
              traderId: t.id,
              entryDate: '2026-10-02',
              expected: '0.00/300.00',
              actual: '0.00/299.00',
            }),
          ]),
        );
        expect(result.mismatches).toHaveLength(2);
        expect(alert).toHaveBeenCalled();
      } finally {
        alert.mockRestore();
      }
    });

    it('only reads: a check run changes nothing', async () => {
      const before = await fx.db
        .select()
        .from(ledgerDailyBalances)
        .where(eq(ledgerDailyBalances.tenantId, shop));

      await reconciliation.run([shop]).catch(() => undefined);

      expect(
        await fx.db
          .select()
          .from(ledgerDailyBalances)
          .where(eq(ledgerDailyBalances.tenantId, shop)),
      ).toEqual(before);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('performance', () => {
    let token: string;
    let kissan: Trader;

    beforeAll(async () => {
      await app.listen(0);
      const shop = await fx.tenant();
      const owner = await fx.user('owner', shop);
      token = await login(owner.phone);
      kissan = await trader({}, token);
      // 50,000 entries over ~3 years (about 45 a day), one bulk insert as the
      // table owner; the trigger fills the daily snapshots.
      await fx.pool.query(
        `insert into ledger_entries
           (tenant_id, trader_id, entry_date, source_type, source_id, debit, credit, narration)
         select $1, $2, date '2026-10-31' - (g / 45),
                case when g % 2 = 0 then 'purchase' else 'payment' end,
                gen_random_uuid(),
                case when g % 2 = 0 then 0 else 900 end,
                case when g % 2 = 0 then 1000 else 0 end,
                'Perf ' || g
           from generate_series(1, $3::int) as g`,
        [shop, kissan.id, PERF_ENTRIES],
      );
      await fx.pool.query('analyze ledger_entries');
      await fx.pool.query('analyze ledger_daily_balances');
    }, 120_000);

    /** Median of 5 timed calls, in ms. */
    async function medianMs(fn: () => Promise<unknown>) {
      const times: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const start = process.hrtime.bigint();
        await fn();
        times.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
      return times.sort((a, b) => a - b)[2];
    }

    it(`statement for last month of a trader with ${PERF_ENTRIES} entries in under ${STATEMENT_BUDGET_MS} ms`, async () => {
      const call = () =>
        statement(token, kissan.id, {
          from: '2026-10-01',
          to: '2026-10-31',
        }).expect(200);
      const warm = await call();
      // 25,000 purchases of 1,000 and 25,000 payments of 900 in all.
      expect(warm.body.closingBalance).toBe('-2500000.00');
      expect(warm.body.meta.total).toBeGreaterThan(1300);

      const median = await medianMs(call);
      const deepPage = await medianMs(() =>
        statement(token, kissan.id, { page: 400, limit: 100 }).expect(200),
      );
      const all = await medianMs(() => balances(token).expect(200));
      console.log(
        `ledger with ${PERF_ENTRIES} entries: last-month statement ${median.toFixed(1)} ms, page 400 of the whole khata ${deepPage.toFixed(1)} ms, balances ${all.toFixed(1)} ms (request medians)`,
      );

      expect(median).toBeLessThan(STATEMENT_BUDGET_MS);
      expect(deepPage).toBeLessThan(DEEP_PAGE_BUDGET_MS);
      expect(all).toBeLessThan(STATEMENT_BUDGET_MS);
    });

    it('the last page ends on the closing balance', async () => {
      const res = await statement(token, kissan.id, {
        page: 500,
        limit: 100,
      }).expect(200);

      expect(res.body.data).toHaveLength(100);
      expect(res.body.data.at(-1).balance).toBe(res.body.closingBalance);
      expect(res.body.closingBalance).toBe('-2500000.00');
    });
  });
});
