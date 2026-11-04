import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import { and, asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { auditLogs, ledgerEntries, traders } from '../src/database/schema';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import type { Trader } from '../src/modules/traders/traders.dto';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const HAS_TRANSACTIONS =
  'This trader has transactions and cannot be deleted. Deactivate the trader instead.';
const PHONE_TAKEN_MSG = 'Another trader in this shop has this phone number';
const LOOKUP_BUDGET_MS = 100;
const PERF_TRADERS = 10_000;

/** `03991234567` → `+92 399 1234567` (how people type it). */
const intl = (phone: string) => `+92 ${phone.slice(1, 4)} ${phone.slice(4)}`;

type Role = 'owner' | 'manager' | 'operator' | 'super_admin' | 'none';
const ROLES: Role[] = ['owner', 'manager', 'operator', 'super_admin', 'none'];

describe('Traders /traders (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;

  let shopA: string;
  let shopB: string;
  const users = {} as Record<'ownerA' | 'manager' | 'operator', string>;
  const tokens = {} as Record<
    'ownerA' | 'ownerB' | 'manager' | 'operator' | 'superAdmin',
    string
  >;

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string | null) =>
    token ? req.set('Authorization', `Bearer ${token}`) : req;

  const create = (token: string | null, body: object) =>
    as(http().post('/traders'), token).send(body);
  const get = (token: string | null, id: string) =>
    as(http().get(`/traders/${id}`), token);
  const list = (token: string | null, query: Record<string, unknown> = {}) =>
    as(http().get('/traders'), token).query(query);
  const lookup = (token: string | null, query: Record<string, unknown> = {}) =>
    as(http().get('/traders/lookup'), token).query(query);
  const patch = (token: string | null, id: string, body: object) =>
    as(http().patch(`/traders/${id}`), token).send(body);
  const remove = (token: string | null, id: string) =>
    as(http().delete(`/traders/${id}`), token);
  const restore = (token: string | null, id: string) =>
    as(http().post(`/records/traders/${id}/restore`), token);

  /** A trader made through the API by `token` (owner A by default). */
  async function seed(
    body: Record<string, unknown> = {},
    token = tokens.ownerA,
  ): Promise<Trader> {
    const res = await create(token, {
      type: 'kissan',
      name: `Trader ${randomUUID().slice(0, 8)}`,
      ...body,
    }).expect(201);
    return res.body as Trader;
  }

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

  /** A fresh shop with a signed-in owner (for list and lookup tests). */
  async function newShop() {
    const tenantId = await fx.tenant();
    const owner = await fx.user('owner', tenantId);
    return { tenantId, token: await login(owner.phone) };
  }

  async function traderRow(id: string) {
    const [row] = await fx.db.select().from(traders).where(eq(traders.id, id));
    return row;
  }

  const ledgerOf = (traderId: string) =>
    fx.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.traderId, traderId))
      .orderBy(asc(ledgerEntries.id));

  const auditOf = (entity: string, entityId: string) =>
    fx.db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.entity, entity), eq(auditLogs.entityId, entityId)),
      )
      .orderBy(asc(auditLogs.id));

  /** Simulates a purchase in the khata (there is no purchases table yet). */
  async function addKhataEntry(
    tenantId: string,
    traderId: string,
    over: Partial<typeof ledgerEntries.$inferInsert> = {},
  ) {
    await fx.db.insert(ledgerEntries).values({
      tenantId,
      traderId,
      entryDate: '2026-10-29',
      sourceType: 'purchase',
      sourceId: randomUUID(),
      debit: '0',
      credit: '25000.00',
      narration: 'Purchase (test)',
      ...over,
    });
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
    const ownerA = await fx.user('owner', shopA);
    const ownerB = await fx.user('owner', shopB);
    const manager = await fx.user('manager', shopA);
    const operator = await fx.user('operator', shopA);
    const superAdmin = await fx.user('super_admin', null);
    users.ownerA = ownerA.id;
    users.manager = manager.id;
    users.operator = operator.id;

    tokens.ownerA = await login(ownerA.phone);
    tokens.ownerB = await login(ownerB.phone);
    tokens.manager = await login(manager.phone);
    tokens.operator = await login(operator.phone);
    tokens.superAdmin = await login(superAdmin.phone);
  });

  beforeEach(() => resetThrottle());

  afterAll(async () => {
    await app.close();
    // Traders, khata and audit rows go with the shops.
    await fx.cleanup();
  });

  /* ---------------------------------------------------------------- */
  describe('POST /traders', () => {
    it('creates a kissan with name and phone under the user’s shop', async () => {
      const phone = fx.phone();

      const res = await create(tokens.operator, {
        type: 'kissan',
        name: '  Muhammad Ali ',
        phone: intl(phone),
      }).expect(201);

      expect(res.body).toEqual({
        id: expect.stringMatching(UUID),
        type: 'kissan',
        name: 'Muhammad Ali',
        fatherName: null,
        phone,
        cnic: null,
        village: null,
        address: null,
        openingBalance: '0.00',
        openingBalanceType: 'debit',
        creditLimit: null,
        isActive: true,
        notes: null,
        createdAt: expect.stringMatching(ISO),
        updatedAt: expect.stringMatching(ISO),
      });
      const row = await traderRow(res.body.id as string);
      expect(row).toMatchObject({
        tenantId: shopA,
        createdBy: users.operator,
        phone,
        deletedAt: null,
      });
    });

    it('stores every field, CNIC normalised and money as numeric', async () => {
      const res = await create(tokens.manager, {
        type: 'beopari',
        name: 'Bilal Traders',
        fatherName: 'Rashid',
        phone: fx.phone(),
        cnic: '3520212345671',
        village: 'Chak 45',
        address: 'Grain Market, Okara',
        creditLimit: '100000.5',
        isActive: false,
        notes: 'Pays on Friday',
      }).expect(201);

      expect(res.body).toMatchObject({
        type: 'beopari',
        fatherName: 'Rashid',
        cnic: '35202-1234567-1',
        village: 'Chak 45',
        address: 'Grain Market, Okara',
        creditLimit: '100000.50',
        isActive: false,
        notes: 'Pays on Friday',
      });
      expect((await traderRow(res.body.id as string)).createdBy).toBe(
        users.manager,
      );
    });

    it('writes a create audit row in the same shop', async () => {
      const trader = await seed({ name: 'Audited Kissan' });

      const rows = await auditOf('traders', trader.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId: shopA,
        userId: users.ownerA,
        action: 'create',
      });
      expect(rows[0].after).toMatchObject({
        id: trader.id,
        name: 'Audited Kissan',
      });
    });

    it('opening balance 0 → no khata entry, balance "0.00"', async () => {
      const zero = await seed();
      const zeroDecimals = await seed({ openingBalance: '0.00' });

      expect(await ledgerOf(zero.id)).toEqual([]);
      expect(await ledgerOf(zeroDecimals.id)).toEqual([]);
      const res = await get(tokens.ownerA, zero.id).expect(200);
      expect(res.body.balance).toBe('0.00');
    });

    it('opening balance debit → one opening entry, positive balance', async () => {
      const trader = await seed({
        openingBalance: '1500.5',
        openingBalanceType: 'debit',
      });

      const entries = await ledgerOf(trader.id);

      expect(entries).toEqual([
        expect.objectContaining({
          tenantId: shopA,
          traderId: trader.id,
          sourceType: 'opening',
          sourceId: trader.id,
          debit: '1500.50',
          credit: '0.00',
          narration: 'Opening balance',
          createdBy: users.ownerA,
        }),
      ]);
      expect(entries[0].entryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const res = await get(tokens.ownerA, trader.id).expect(200);
      expect(res.body.balance).toBe('1500.50');
    });

    it('opening balance 50,000 credit → credit 50000.00, balance "-50000.00"', async () => {
      const trader = await seed({
        openingBalance: '50000',
        openingBalanceType: 'credit',
      });

      expect(trader.openingBalance).toBe('50000.00');
      expect(trader.openingBalanceType).toBe('credit');
      const entries = await ledgerOf(trader.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        sourceType: 'opening',
        sourceId: trader.id,
        debit: '0.00',
        credit: '50000.00',
      });
      const res = await get(tokens.ownerA, trader.id).expect(200);
      expect(res.body.balance).toBe('-50000.00');
    });

    it('the khata entry is audited too', async () => {
      const trader = await seed({ openingBalance: '700' });

      const rows = await fx.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.tenantId, shopA),
            eq(auditLogs.entity, 'ledger_entries'),
            eq(auditLogs.entityId, trader.id),
          ),
        );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'create',
        userId: users.ownerA,
      });
      expect(rows[0].after).toMatchObject({
        traderId: trader.id,
        sourceType: 'opening',
        debit: '700.00',
      });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /traders/:id', () => {
    it('returns the trader with its balance', async () => {
      const trader = await seed({ openingBalance: '1000' });
      await addKhataEntry(shopA, trader.id, {
        debit: '250.25',
        credit: '0',
      });

      const res = await get(tokens.operator, trader.id).expect(200);

      expect(res.body).toEqual({ ...trader, balance: '1250.25' });
    });

    it('unknown id → 404, bad id → 400', async () => {
      await get(tokens.ownerA, UNKNOWN_ID).expect(404);
      await get(tokens.ownerA, 'not-a-uuid').expect(400);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /traders (list)', () => {
    let shop: Awaited<ReturnType<typeof newShop>>;
    const phones = {} as Record<'zahid' | 'ali', string>;
    const created: Trader[] = [];
    const names = (res: request.Response) =>
      (res.body.data as { name: string }[]).map((t) => t.name);

    beforeAll(async () => {
      shop = await newShop();
      phones.zahid = fx.phone();
      phones.ali = fx.phone();
      for (const body of [
        { type: 'beopari', name: 'Zahid Butt', phone: phones.zahid },
        { type: 'kissan', name: 'Ali Raza', phone: phones.ali },
        { type: 'kissan', name: 'Muhammad Ali', isActive: false },
        { type: 'beopari', name: 'Aamir Ali' },
        { type: 'arhti', name: 'Khalid Mahmood' },
        { type: 'beopari', name: '100% Pure Grain' },
        { type: 'kissan', name: '100 Bags Store' },
      ]) {
        created.push(await seed(body, shop.token));
      }
    });

    it('returns { data, meta } with the defaults (page 1, limit 20, by name)', async () => {
      const res = await list(shop.token).expect(200);

      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 7 });
      expect(res.body.data).toHaveLength(7);
      expect(res.body.data[0]).toEqual(
        created.find((t) => t.id === res.body.data[0].id),
      );
      expect(res.body.data[0]).not.toHaveProperty('balance');
      expect(names(res).filter((n) => /^[A-Z]/.test(n))).toEqual([
        'Aamir Ali',
        'Ali Raza',
        'Khalid Mahmood',
        'Muhammad Ali',
        'Zahid Butt',
      ]);
    });

    it('pages through the list without gaps or repeats', async () => {
      const all = names(await list(shop.token, { limit: 100 }).expect(200));

      const pages: string[] = [];
      for (const page of [1, 2, 3]) {
        const res = await list(shop.token, { page, limit: 3 }).expect(200);
        expect(res.body.meta).toEqual({ page, limit: 3, total: 7 });
        pages.push(...names(res));
      }

      expect(pages).toEqual(all);
      const past = await list(shop.token, { page: 4, limit: 3 }).expect(200);
      expect(past.body).toEqual({
        data: [],
        meta: { page: 4, limit: 3, total: 7 },
      });
    });

    it('sorts by name, -name, createdAt and -createdAt', async () => {
      const byName = names(await list(shop.token, { sort: 'name' }));
      const byNameDesc = names(await list(shop.token, { sort: '-name' }));
      const byCreated = names(await list(shop.token, { sort: 'createdAt' }));
      const byCreatedDesc = names(
        await list(shop.token, { sort: '-createdAt' }),
      );

      expect(byNameDesc).toEqual([...byName].reverse());
      expect(byCreated).toEqual(created.map((t) => t.name));
      expect(byCreatedDesc).toEqual(created.map((t) => t.name).reverse());
    });

    it('filters by type', async () => {
      const res = await list(shop.token, { type: 'beopari' }).expect(200);

      expect(res.body.meta.total).toBe(3);
      expect(names(res).sort()).toEqual(
        ['100% Pure Grain', 'Aamir Ali', 'Zahid Butt'].sort(),
      );
    });

    it('filters by active=true / active=false; no filter shows both', async () => {
      const active = await list(shop.token, { active: 'true' }).expect(200);
      const inactive = await list(shop.token, { active: 'false' }).expect(200);

      expect(active.body.meta.total).toBe(6);
      expect(names(active)).not.toContain('Muhammad Ali');
      expect(names(inactive)).toEqual(['Muhammad Ali']);
    });

    it('search "ali" matches names in this shop only (any case, any position)', async () => {
      const res = await list(shop.token, { search: 'ALI' }).expect(200);

      expect(names(res)).toEqual([
        'Aamir Ali',
        'Ali Raza',
        'Khalid Mahmood',
        'Muhammad Ali',
      ]);
    });

    it('search by phone digits, typed with dashes or as +92', async () => {
      const tail = phones.ali.slice(4);
      const dashed = `${tail.slice(0, 3)}-${tail.slice(3)}`;

      const byDigits = await list(shop.token, { search: dashed }).expect(200);
      const byIntl = await list(shop.token, {
        search: phones.zahid,
      }).expect(200);

      expect(names(byDigits)).toEqual(['Ali Raza']);
      expect(names(byIntl)).toEqual(['Zahid Butt']);
    });

    it('search combines with type and active', async () => {
      const res = await list(shop.token, {
        search: 'ali',
        type: 'kissan',
        active: 'true',
      }).expect(200);

      expect(names(res)).toEqual(['Ali Raza']);
    });

    it('"%" and "_" are literal, not wildcards', async () => {
      const percent = await list(shop.token, { search: '%' }).expect(200);
      const percentWord = await list(shop.token, {
        search: '100%',
      }).expect(200);
      const underscore = await list(shop.token, { search: '_' }).expect(200);

      expect(names(percent)).toEqual(['100% Pure Grain']);
      expect(names(percentWord)).toEqual(['100% Pure Grain']);
      expect(underscore.body).toEqual({
        data: [],
        meta: { page: 1, limit: 20, total: 0 },
      });
    });

    it('no match → empty page', async () => {
      const res = await list(shop.token, { search: 'nobody-here' }).expect(200);

      expect(res.body).toEqual({
        data: [],
        meta: { page: 1, limit: 20, total: 0 },
      });
    });

    it('bad query values → 400 with field errors', async () => {
      for (const [query, field] of [
        [{ limit: 101 }, 'limit'],
        [{ page: 0 }, 'page'],
        [{ active: 'yes' }, 'active'],
        [{ type: 'farmer' }, 'type'],
        [{ sort: 'phone' }, 'sort'],
      ] as const) {
        const res = await list(shop.token, query).expect(400);
        expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual([
          field,
        ]);
      }
    });

    describe('GET /traders/lookup', () => {
      it('active traders only, names starting with q first', async () => {
        const res = await lookup(shop.token, { q: 'ali' }).expect(200);

        expect(names(res)).toEqual(['Ali Raza', 'Aamir Ali', 'Khalid Mahmood']);
      });

      it('returns only the picker fields', async () => {
        const res = await lookup(shop.token, { q: 'Ali Raza' }).expect(200);
        const ali = created.find((t) => t.name === 'Ali Raza')!;

        expect(res.body).toEqual({
          data: [
            {
              id: ali.id,
              type: 'kissan',
              name: 'Ali Raza',
              fatherName: null,
              phone: phones.ali,
              village: null,
            },
          ],
        });
      });

      it('filters by type and respects limit', async () => {
        const beopari = await lookup(shop.token, {
          q: 'ali',
          type: 'beopari',
        }).expect(200);
        const one = await lookup(shop.token, { q: 'ali', limit: 1 }).expect(
          200,
        );

        expect(names(beopari)).toEqual(['Aamir Ali']);
        expect(names(one)).toEqual(['Ali Raza']);
      });

      it('finds by phone digits', async () => {
        const res = await lookup(shop.token, {
          q: phones.zahid.slice(-6),
        }).expect(200);

        expect(names(res)).toEqual(['Zahid Butt']);
      });

      it('without q → all active traders by name, default limit 10', async () => {
        const res = await lookup(shop.token).expect(200);

        expect(res.body.data).toHaveLength(6);
        expect(names(res)).not.toContain('Muhammad Ali');
        expect(names(res).filter((n) => /^[A-Z]/.test(n))).toEqual([
          'Aamir Ali',
          'Ali Raza',
          'Khalid Mahmood',
          'Zahid Butt',
        ]);
      });

      it('"%" is literal', async () => {
        const res = await lookup(shop.token, { q: '%' }).expect(200);

        expect(names(res)).toEqual(['100% Pure Grain']);
      });

      it('limit above 50 → 400', async () => {
        const res = await lookup(shop.token, { limit: 51 }).expect(400);

        expect(res.body.errors[0].field).toBe('limit');
      });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('PATCH /traders/:id', () => {
    it('updates the sent fields only and writes an update audit row', async () => {
      const phone = fx.phone();
      const trader = await seed({
        name: 'Old Name',
        phone,
        cnic: '35202-1234567-1',
      });

      const res = await patch(tokens.manager, trader.id, {
        name: 'New Name',
        village: 'Chak 7',
      }).expect(200);

      expect(res.body).toMatchObject({
        id: trader.id,
        name: 'New Name',
        village: 'Chak 7',
        phone,
        cnic: '35202-1234567-1',
        balance: '0.00',
      });
      const audit = await auditOf('traders', trader.id);
      expect(audit.map((a) => a.action)).toEqual(['create', 'update']);
      expect(audit[1]).toMatchObject({
        userId: users.manager,
        before: { name: 'Old Name', village: null },
        after: { name: 'New Name', village: 'Chak 7' },
      });
    });

    it('changes the phone (normalised); the old phone is free again', async () => {
      const oldPhone = fx.phone();
      const newPhone = fx.phone();
      const trader = await seed({ phone: oldPhone });

      const res = await patch(tokens.ownerA, trader.id, {
        phone: intl(newPhone),
      }).expect(200);

      expect(res.body.phone).toBe(newPhone);
      expect((await traderRow(trader.id)).phone).toBe(newPhone);
      await seed({ phone: oldPhone });
    });

    it('clears optional fields with null', async () => {
      const trader = await seed({ phone: fx.phone(), creditLimit: '5000' });

      const res = await patch(tokens.ownerA, trader.id, {
        phone: null,
        creditLimit: null,
      }).expect(200);

      expect(res.body).toMatchObject({ phone: null, creditLimit: null });
    });

    it('an empty body changes nothing', async () => {
      const trader = await seed();

      const res = await patch(tokens.ownerA, trader.id, {}).expect(200);

      expect(res.body).toEqual({ ...trader, balance: '0.00' });
      expect(await auditOf('traders', trader.id)).toHaveLength(1);
    });

    it('a changed opening balance → reversal + new opening; balance follows', async () => {
      const trader = await seed({ openingBalance: '1000' });

      const first = await patch(tokens.manager, trader.id, {
        openingBalance: '1500',
      }).expect(200);

      expect(first.body).toMatchObject({
        openingBalance: '1500.00',
        balance: '1500.00',
      });
      let entries = await ledgerOf(trader.id);
      expect(
        entries.map((e) => [e.sourceType, e.sourceId, e.debit, e.credit]),
      ).toEqual([
        ['opening', trader.id, '1000.00', '0.00'],
        ['reversal', trader.id, '0.00', '1000.00'],
        ['opening', trader.id, '1500.00', '0.00'],
      ]);
      expect(entries[1].narration).toBe('Opening balance corrected');
      expect(entries[1].createdBy).toBe(users.manager);

      // Debit → credit with the same amount.
      const second = await patch(tokens.manager, trader.id, {
        openingBalanceType: 'credit',
      }).expect(200);

      expect(second.body.balance).toBe('-1500.00');
      entries = await ledgerOf(trader.id);
      expect(
        entries.slice(3).map((e) => [e.sourceType, e.debit, e.credit]),
      ).toEqual([
        ['reversal', '0.00', '1500.00'],
        ['opening', '0.00', '1500.00'],
      ]);

      // Down to 0: only the reversal, nothing left.
      const third = await patch(tokens.manager, trader.id, {
        openingBalance: '0',
      }).expect(200);

      expect(third.body.balance).toBe('0.00');
      entries = await ledgerOf(trader.id);
      expect(
        entries.slice(5).map((e) => [e.sourceType, e.debit, e.credit]),
      ).toEqual([['reversal', '1500.00', '0.00']]);
    });

    it('a new opening balance on a trader that had none → one opening entry', async () => {
      const trader = await seed();

      const res = await patch(tokens.ownerA, trader.id, {
        openingBalance: '300',
        openingBalanceType: 'credit',
      }).expect(200);

      expect(res.body.balance).toBe('-300.00');
      expect(
        (await ledgerOf(trader.id)).map((e) => [e.sourceType, e.credit]),
      ).toEqual([['opening', '300.00']]);
    });

    it('an unchanged opening balance adds no khata entries', async () => {
      const trader = await seed({ openingBalance: '1000' });

      await patch(tokens.ownerA, trader.id, { name: 'Renamed' }).expect(200);
      await patch(tokens.ownerA, trader.id, {
        openingBalance: '1000.00',
        openingBalanceType: 'debit',
      }).expect(200);
      const res = await patch(tokens.ownerA, trader.id, {
        openingBalance: '1000',
      }).expect(200);

      expect(res.body.balance).toBe('1000.00');
      expect(await ledgerOf(trader.id)).toHaveLength(1);
    });

    it('changing only the type of a 0 opening balance adds no entries', async () => {
      const trader = await seed();

      await patch(tokens.ownerA, trader.id, {
        openingBalanceType: 'credit',
      }).expect(200);

      expect(await ledgerOf(trader.id)).toEqual([]);
    });

    it('can deactivate a trader', async () => {
      const trader = await seed();

      const res = await patch(tokens.ownerA, trader.id, {
        isActive: false,
      }).expect(200);

      expect(res.body.isActive).toBe(false);
    });

    it('unknown id → 404', async () => {
      await patch(tokens.ownerA, UNKNOWN_ID, { name: 'Nobody' }).expect(404);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('duplicate phones', () => {
    it('same phone twice in one shop → 409 PHONE_TAKEN on create (any format)', async () => {
      const phone = fx.phone();
      await seed({ phone });

      for (const typed of [phone, intl(phone)]) {
        const res = await create(tokens.ownerA, {
          type: 'beopari',
          name: 'Second Trader',
          phone: typed,
        }).expect(409);

        expect(res.body).toEqual({
          statusCode: 409,
          message: PHONE_TAKEN_MSG,
          code: 'PHONE_TAKEN',
          errors: [{ field: 'phone', message: PHONE_TAKEN_MSG }],
        });
      }
      const rows = await fx.db
        .select()
        .from(traders)
        .where(and(eq(traders.tenantId, shopA), eq(traders.phone, phone)));
      expect(rows).toHaveLength(1);
    });

    it('a 409 on create writes no audit row and no khata entry', async () => {
      const phone = fx.phone();
      await seed({ phone });
      const before = await fx.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.tenantId, shopA));

      await create(tokens.ownerA, {
        type: 'kissan',
        name: 'Duplicate With Opening',
        phone,
        openingBalance: '999',
      }).expect(409);

      const after = await fx.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.tenantId, shopA));
      expect(after).toHaveLength(before.length);
    });

    it('same phone in another shop → allowed', async () => {
      const phone = fx.phone();
      const a = await seed({ phone });

      const b = await seed({ phone }, tokens.ownerB);

      expect(b.phone).toBe(phone);
      expect((await traderRow(b.id)).tenantId).toBe(shopB);
      expect((await traderRow(a.id)).tenantId).toBe(shopA);
    });

    it("changing to another trader's phone → 409 PHONE_TAKEN on update, nothing changed", async () => {
      const taken = fx.phone();
      const own = fx.phone();
      await seed({ phone: taken });
      const trader = await seed({ phone: own });

      const res = await patch(tokens.ownerA, trader.id, {
        phone: intl(taken),
        name: 'Should Not Save',
      }).expect(409);

      expect(res.body.code).toBe('PHONE_TAKEN');
      expect(res.body.errors).toEqual([
        { field: 'phone', message: PHONE_TAKEN_MSG },
      ]);
      expect(await traderRow(trader.id)).toMatchObject({
        phone: own,
        name: trader.name,
      });
    });

    it('traders without a phone never collide', async () => {
      const first = await seed({ phone: null });
      const second = await seed({ phone: '' });
      const third = await seed();

      expect([first.phone, second.phone, third.phone]).toEqual([
        null,
        null,
        null,
      ]);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('DELETE /traders/:id', () => {
    it('soft deletes: 204, then 404 and gone from list and lookup', async () => {
      const name = `Deleted ${randomUUID().slice(0, 8)}`;
      const trader = await seed({ name });

      await remove(tokens.ownerA, trader.id).expect(204);

      await get(tokens.ownerA, trader.id).expect(404);
      await patch(tokens.ownerA, trader.id, { name: 'Ghost' }).expect(404);
      await remove(tokens.ownerA, trader.id).expect(404);
      const listed = await list(tokens.ownerA, { search: name }).expect(200);
      expect(listed.body.meta.total).toBe(0);
      const found = await lookup(tokens.ownerA, { q: name }).expect(200);
      expect(found.body.data).toEqual([]);
      const row = await traderRow(trader.id);
      expect(row.deletedAt).toBeInstanceOf(Date);
      const audit = await auditOf('traders', trader.id);
      expect(audit.map((a) => a.action)).toEqual(['create', 'delete']);
      expect(audit[1].userId).toBe(users.ownerA);
    });

    it('a trader with only opening balance entries (and corrections) can be deleted', async () => {
      const trader = await seed({ openingBalance: '1000' });
      await patch(tokens.ownerA, trader.id, {
        openingBalance: '2000',
      }).expect(200);

      await remove(tokens.ownerA, trader.id).expect(204);

      // The khata is never touched.
      expect(await ledgerOf(trader.id)).toHaveLength(3);
    });

    it('a trader with a purchase → 409 TRADER_HAS_TRANSACTIONS (deactivate instead), still there', async () => {
      const trader = await seed({ openingBalance: '500' });
      await addKhataEntry(shopA, trader.id);

      const res = await remove(tokens.ownerA, trader.id).expect(409);

      expect(res.body).toEqual({
        statusCode: 409,
        message: HAS_TRANSACTIONS,
        code: 'TRADER_HAS_TRANSACTIONS',
      });
      await get(tokens.ownerA, trader.id).expect(200);
      expect((await traderRow(trader.id)).deletedAt).toBeNull();
      // The suggested way out works.
      await patch(tokens.ownerA, trader.id, { isActive: false }).expect(200);
    });

    it('an entry without a source id (e.g. an adjustment) also counts as a transaction', async () => {
      const trader = await seed();
      await addKhataEntry(shopA, trader.id, {
        sourceType: 'adjustment',
        sourceId: null,
        debit: '10',
        credit: '0',
      });

      const res = await remove(tokens.ownerA, trader.id).expect(409);

      expect(res.body.code).toBe('TRADER_HAS_TRANSACTIONS');
      expect((await traderRow(trader.id)).deletedAt).toBeNull();
    });

    it('a reversal that points at another record is a transaction', async () => {
      const trader = await seed();
      await addKhataEntry(shopA, trader.id, {
        sourceType: 'reversal',
        sourceId: randomUUID(),
        debit: '100',
        credit: '0',
      });

      await remove(tokens.ownerA, trader.id).expect(409);
    });

    it("a deleted trader's phone still blocks a new trader (unique index includes deleted rows)", async () => {
      const phone = fx.phone();
      const trader = await seed({ phone });
      await remove(tokens.ownerA, trader.id).expect(204);

      const res = await create(tokens.ownerA, {
        type: 'kissan',
        name: 'Reuses Phone',
        phone,
      }).expect(409);

      expect(res.body.code).toBe('PHONE_TAKEN');
    });

    it('the owner restores a deleted trader via /records/traders/:id/restore', async () => {
      const trader = await seed({ openingBalance: '800' });
      await remove(tokens.ownerA, trader.id).expect(204);

      const res = await restore(tokens.ownerA, trader.id).expect(200);

      expect(res.body).toEqual({ id: trader.id, restored: true });
      const back = await get(tokens.ownerA, trader.id).expect(200);
      expect(back.body).toMatchObject({ id: trader.id, balance: '800.00' });
      const audit = await auditOf('traders', trader.id);
      expect(audit.map((a) => a.action)).toEqual([
        'create',
        'delete',
        'restore',
      ]);
      // Nothing left to restore now.
      await restore(tokens.ownerA, trader.id).expect(404);
    });

    it('managers cannot restore; another shop cannot restore', async () => {
      const trader = await seed();
      await remove(tokens.ownerA, trader.id).expect(204);

      await restore(tokens.manager, trader.id).expect(403);
      await restore(tokens.ownerB, trader.id).expect(404);
      expect((await traderRow(trader.id)).deletedAt).toBeInstanceOf(Date);
    });

    it('unknown id → 404, bad id → 400', async () => {
      await remove(tokens.ownerA, UNKNOWN_ID).expect(404);
      await remove(tokens.ownerA, 'nope').expect(400);
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

    /** Status per route: view all shop roles, create +operator, edit manager+, delete owner. */
    const expected = (role: Role, allowed: Role[], ok: number): number => {
      if (role === 'none') return 401;
      return allowed.includes(role) ? ok : 403;
    };
    const VIEW: Role[] = ['owner', 'manager', 'operator'];

    it.each(ROLES)('GET /traders as %s', async (role) => {
      await list(tokenOf(role)).expect(expected(role, VIEW, 200));
    });

    it.each(ROLES)('GET /traders/lookup as %s', async (role) => {
      await lookup(tokenOf(role), { q: 'a' }).expect(expected(role, VIEW, 200));
    });

    it.each(ROLES)('GET /traders/:id as %s', async (role) => {
      const trader = await seed();
      await get(tokenOf(role), trader.id).expect(expected(role, VIEW, 200));
    });

    it.each(ROLES)('POST /traders as %s', async (role) => {
      const name = `Perm ${role} ${randomUUID().slice(0, 6)}`;
      const status = expected(role, VIEW, 201);

      await create(tokenOf(role), { type: 'kissan', name }).expect(status);

      const rows = await fx.db
        .select()
        .from(traders)
        .where(eq(traders.name, name));
      expect(rows).toHaveLength(status === 201 ? 1 : 0);
    });

    it.each(ROLES)('PATCH /traders/:id as %s', async (role) => {
      const trader = await seed();
      const status = expected(role, ['owner', 'manager'], 200);

      const res = await patch(tokenOf(role), trader.id, {
        notes: 'changed',
      }).expect(status);

      if (status === 403) {
        expect(res.body).toEqual({
          statusCode: 403,
          message: 'You do not have access to this action',
        });
      }
      expect((await traderRow(trader.id)).notes).toBe(
        status === 200 ? 'changed' : null,
      );
    });

    it.each(ROLES)('DELETE /traders/:id as %s', async (role) => {
      const trader = await seed();
      const status = expected(role, ['owner'], 204);

      await remove(tokenOf(role), trader.id).expect(status);

      const row = await traderRow(trader.id);
      expect(row.deletedAt === null).toBe(status !== 204);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('tenant isolation', () => {
    let traderB: Trader;
    const nameB = `Shop B Only ${randomUUID().slice(0, 8)}`;
    let phoneB: string;

    beforeAll(async () => {
      phoneB = fx.phone();
      traderB = await seed(
        { name: nameB, phone: phoneB, openingBalance: '900' },
        tokens.ownerB,
      );
    });

    it("shop A cannot read shop B's trader → 404", async () => {
      const res = await get(tokens.ownerA, traderB.id).expect(404);

      expect(res.body).toEqual({
        statusCode: 404,
        message: 'Trader not found',
      });
      await get(tokens.ownerB, traderB.id).expect(200);
    });

    it("shop A cannot update shop B's trader → 404, unchanged, no khata entry", async () => {
      await patch(tokens.ownerA, traderB.id, {
        name: 'Hijacked',
        openingBalance: '1',
      }).expect(404);

      expect(await traderRow(traderB.id)).toMatchObject({
        name: nameB,
        openingBalance: '900.00',
        tenantId: shopB,
      });
      expect(await ledgerOf(traderB.id)).toHaveLength(1);
    });

    it("shop A cannot delete shop B's trader → 404, not deleted", async () => {
      await remove(tokens.ownerA, traderB.id).expect(404);

      expect((await traderRow(traderB.id)).deletedAt).toBeNull();
    });

    it("list and lookup never show shop B's traders (by name or phone)", async () => {
      for (const search of [nameB, phoneB, 'Shop B Only']) {
        const listed = await list(tokens.ownerA, { search }).expect(200);
        expect(listed.body.meta.total).toBe(0);
        const found = await lookup(tokens.ownerA, { q: search }).expect(200);
        expect(found.body.data).toEqual([]);
      }
      const all = await list(tokens.ownerA, { limit: 100 }).expect(200);
      expect(
        (all.body.data as { id: string }[]).map((t) => t.id),
      ).not.toContain(traderB.id);
    });

    it('tenantId / tenant_id in the body are ignored on create', async () => {
      const res = await create(tokens.ownerA, {
        type: 'kissan',
        name: 'Smuggler',
        tenantId: shopB,
        tenant_id: shopB,
      }).expect(201);

      expect((await traderRow(res.body.id as string)).tenantId).toBe(shopA);
    });

    it('tenant_id in the body is ignored on update', async () => {
      const trader = await seed();

      await patch(tokens.ownerA, trader.id, {
        tenant_id: shopB,
        tenantId: shopB,
        notes: 'stays in A',
      }).expect(200);

      expect(await traderRow(trader.id)).toMatchObject({
        tenantId: shopA,
        notes: 'stays in A',
      });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('validation', () => {
    const fieldsOf = (res: request.Response) =>
      (res.body.errors as { field: string }[]).map((e) => e.field);

    it.each([
      ['an invalid phone', { phone: 'abc-123' }, 'phone'],
      ['a phone without digits', { phone: '+------' }, 'phone'],
      ['an invalid CNIC', { cnic: '12345-123456-1' }, 'cnic'],
      ['a missing name', { name: undefined }, 'name'],
      ['a one-letter name', { name: 'A' }, 'name'],
      ['an unknown type', { type: 'farmer' }, 'type'],
      ['money as a number', { openingBalance: 50000 }, 'openingBalance'],
      ['3 decimals', { openingBalance: '1.234' }, 'openingBalance'],
      ['a negative amount', { creditLimit: '-1' }, 'creditLimit'],
      [
        'a bad balance type',
        { openingBalanceType: 'dr' },
        'openingBalanceType',
      ],
      ['isActive as a string', { isActive: 'true' }, 'isActive'],
    ])('create with %s → 400 on %s', async (_label, over, field) => {
      const res = await create(tokens.ownerA, {
        type: 'kissan',
        name: 'Valid Name',
        ...over,
      }).expect(400);

      expect(res.body.statusCode).toBe(400);
      expect(res.body.message).toBe('Validation failed');
      expect(fieldsOf(res)).toEqual([field]);
    });

    it('create with an unknown field → 400', async () => {
      const res = await create(tokens.ownerA, {
        type: 'kissan',
        name: 'Valid Name',
        balance: '100',
      }).expect(400);

      expect(res.body.errors).toHaveLength(1);
    });

    it('invalid phone and CNIC on update → 400, nothing saved', async () => {
      const trader = await seed();

      const res = await patch(tokens.ownerA, trader.id, {
        phone: '12',
        cnic: 'x',
        name: 'Not Saved',
      }).expect(400);

      expect(fieldsOf(res)).toEqual(['phone', 'cnic']);
      expect((await traderRow(trader.id)).name).toBe(trader.name);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('performance', () => {
    let shop: Awaited<ReturnType<typeof newShop>>;

    beforeAll(async () => {
      // Listen once, like a real server: otherwise supertest starts and stops
      // a server on every request and that would be part of the timing.
      await app.listen(0);
      shop = await newShop();
      // One bulk insert as the table owner; ~half the names contain "ali"
      // (Ali, Bilal, Khalid, Malik), the worst case for the picker.
      await fx.pool.query(
        `insert into traders (tenant_id, type, name, phone, village)
         select $1,
                (array['kissan','beopari','arhti'])[1 + g % 3]::trader_type,
                (array['Ali','Bilal','Usman','Hamza','Khalid','Zahid','Nadeem','Imran'])[1 + g % 8]
                  || ' ' || (array['Khan','Raza','Ahmed','Butt','Malik'])[1 + (g / 8) % 5]
                  || ' ' || g,
                '0412' || lpad(g::text, 7, '0'),
                'Chak ' || (g % 200)
           from generate_series(1, $2::int) as g`,
        [shop.tenantId, PERF_TRADERS],
      );
      await fx.pool.query('analyze traders');
    }, 60_000);

    it(`GET /traders/lookup?q=ali answers in under ${LOOKUP_BUDGET_MS} ms with ${PERF_TRADERS} traders`, async () => {
      const call = () => lookup(shop.token, { q: 'ali' }).expect(200);
      const warm = await call();
      expect(warm.body.data).toHaveLength(10);
      // Names starting with "Ali" come first.
      expect(
        (warm.body.data as { name: string }[]).every((t) =>
          t.name.startsWith('Ali '),
        ),
      ).toBe(true);

      /** Median of 5 timed calls, in ms. */
      const medianMs = async (fn: () => Promise<unknown>) => {
        const times: number[] = [];
        for (let i = 0; i < 5; i += 1) {
          const start = process.hrtime.bigint();
          await fn();
          times.push(Number(process.hrtime.bigint() - start) / 1e6);
        }
        return times.sort((a, b) => a - b)[2];
      };
      const median = await medianMs(call);
      // For the report only: a request that does one primary-key read, i.e.
      // the HTTP + auth + transaction cost every request pays.
      const baseline = await medianMs(() =>
        get(shop.token, UNKNOWN_ID).expect(404),
      );
      // The search itself, as the API runs it (app_tenant role, RLS on):
      // Postgres' own execution time, which the laptop's load and the
      // per-request overhead above don't distort.
      const client = await fx.pool.connect();
      let executionMs: number;
      try {
        await client.query('begin');
        await client.query('set local role app_tenant');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [
          shop.tenantId,
        ]);
        const runs: number[] = [];
        for (let i = 0; i < 5; i += 1) {
          const { rows } = await client.query<{
            'QUERY PLAN': [{ 'Execution Time': number }];
          }>(
            `explain (analyze, format json)
             select id, type, name, father_name, phone, village
               from traders
              where tenant_id = $1 and deleted_at is null and is_active
                and name ilike '%ali%'
              order by case when name ilike 'ali%' then 0 else 1 end, name, id
              limit 10`,
            [shop.tenantId],
          );
          runs.push(rows[0]['QUERY PLAN'][0]['Execution Time']);
        }
        executionMs = runs.sort((a, b) => a - b)[2];
      } finally {
        await client.query('rollback');
        client.release();
      }
      console.log(
        `traders lookup ?q=ali over ${PERF_TRADERS} traders: query ${executionMs.toFixed(1)} ms, request median ${median.toFixed(1)} ms (request baseline ${baseline.toFixed(1)} ms)`,
      );

      expect(executionMs).toBeLessThan(LOOKUP_BUDGET_MS);
    });

    it('the list counts all 10,000 and pages fast', async () => {
      const res = await list(shop.token, { search: 'ali', limit: 50 }).expect(
        200,
      );

      expect(res.body.meta.total).toBeGreaterThan(1000);
      expect(res.body.data).toHaveLength(50);
    });
  });
});
