import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import { and, asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { auditLogs, commodities, tenantSettings } from '../src/database/schema';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import type {
  Commodity,
  CommodityLookupItem,
} from '../src/modules/commodities/commodities.dto';
import { DEFAULT_COMMODITIES } from '../src/modules/commodities/default-commodities';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const NAME_TAKEN_MSG = 'Another commodity in this shop has this name';
const NO_ACCESS = 'You do not have access to this action';

type Role = 'owner' | 'manager' | 'operator' | 'super_admin' | 'none';
const ROLES: Role[] = ['owner', 'manager', 'operator', 'super_admin', 'none'];

const uniq = () => randomUUID().slice(0, 8);

describe('Commodities /commodities (e2e)', () => {
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
    as(http().post('/commodities'), token).send(body);
  const get = (token: string | null, id: string) =>
    as(http().get(`/commodities/${id}`), token);
  const list = (token: string | null, query: Record<string, unknown> = {}) =>
    as(http().get('/commodities'), token).query(query);
  const lookup = (token: string | null, query: Record<string, unknown> = {}) =>
    as(http().get('/commodities/lookup'), token).query(query);
  const patch = (token: string | null, id: string, body: object) =>
    as(http().patch(`/commodities/${id}`), token).send(body);
  const remove = (token: string | null, id: string) =>
    as(http().delete(`/commodities/${id}`), token);
  const restore = (token: string | null, id: string) =>
    as(http().post(`/records/commodities/${id}/restore`), token);

  /** A commodity made through the API by `token` (owner A by default). */
  async function seed(
    body: Record<string, unknown> = {},
    token = tokens.ownerA,
  ): Promise<Commodity> {
    const res = await create(token, {
      name: `Item ${uniq()}`,
      ...body,
    }).expect(201);
    return res.body as Commodity;
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

  /** A fresh shop (no commodities) with a signed-in owner. */
  async function newShop() {
    const tenantId = await fx.tenant();
    const owner = await fx.user('owner', tenantId);
    return { tenantId, token: await login(owner.phone) };
  }

  async function commodityRow(id: string) {
    const [row] = await fx.db
      .select()
      .from(commodities)
      .where(eq(commodities.id, id));
    return row;
  }

  const auditOf = (entityId: string) =>
    fx.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entity, 'commodities'),
          eq(auditLogs.entityId, entityId),
        ),
      )
      .orderBy(asc(auditLogs.id));

  const namesOf = (res: request.Response) =>
    (res.body.data as { name: string }[]).map((c) => c.name);

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
    // Commodities, settings and audit rows go with the shops.
    await fx.cleanup();
  });

  /* ---------------------------------------------------------------- */
  describe('POST /commodities', () => {
    it('creates a commodity with only a name under the user’s shop', async () => {
      const res = await create(tokens.ownerA, { name: '  Gandum ' }).expect(
        201,
      );

      expect(res.body).toEqual({
        id: expect.stringMatching(UUID),
        name: 'Gandum',
        nameUr: null,
        category: null,
        defaultUnit: 'maund',
        bagWeightKg: null,
        commissionPct: null,
        marketFeePct: null,
        labourPerBag: null,
        isActive: true,
        createdAt: expect.stringMatching(ISO),
        updatedAt: expect.stringMatching(ISO),
      });
      expect(await commodityRow(res.body.id as string)).toMatchObject({
        tenantId: shopA,
        createdBy: users.ownerA,
        deletedAt: null,
      });
    });

    it('stores every field; weights and money come back as numeric strings', async () => {
      const res = await create(tokens.manager, {
        name: `Basmati ${uniq()}`,
        nameUr: 'باسمتی',
        category: 'grain',
        defaultUnit: 'bag',
        bagWeightKg: '50.5',
        commissionPct: '3',
        marketFeePct: '0.5',
        labourPerBag: '25',
        isActive: false,
      }).expect(201);

      expect(res.body).toMatchObject({
        nameUr: 'باسمتی',
        category: 'grain',
        defaultUnit: 'bag',
        bagWeightKg: '50.500',
        commissionPct: '3.00',
        marketFeePct: '0.50',
        labourPerBag: '25.00',
        isActive: false,
      });
      expect((await commodityRow(res.body.id as string)).createdBy).toBe(
        users.manager,
      );
    });

    it('writes a create audit row in the same shop', async () => {
      const commodity = await seed({ name: `Audited ${uniq()}` });

      const rows = await auditOf(commodity.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId: shopA,
        userId: users.ownerA,
        action: 'create',
      });
      expect(rows[0].after).toMatchObject({
        id: commodity.id,
        name: commodity.name,
      });
    });

    it('bad fields → 400 with field errors, nothing saved', async () => {
      const name = `Bad ${uniq()}`;
      const res = await create(tokens.ownerA, {
        name,
        defaultUnit: 'ton',
        bagWeightKg: '0',
        commissionPct: '101',
        labourPerBag: 20,
      }).expect(400);

      expect(res.body.message).toBe('Validation failed');
      expect(
        (res.body.errors as { field: string }[]).map((e) => e.field).sort(),
      ).toEqual([
        'bagWeightKg',
        'commissionPct',
        'defaultUnit',
        'labourPerBag',
      ]);
      const rows = await fx.db
        .select()
        .from(commodities)
        .where(eq(commodities.name, name));
      expect(rows).toEqual([]);
    });

    it('an unknown field → 400', async () => {
      await create(tokens.ownerA, {
        name: `Extra ${uniq()}`,
        createdBy: users.manager,
      }).expect(400);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /commodities/:id', () => {
    it('returns the commodity', async () => {
      const commodity = await seed({ commissionPct: '2.5' });

      const res = await get(tokens.operator, commodity.id).expect(200);

      expect(res.body).toEqual(commodity);
    });

    it('unknown id → 404, bad id → 400', async () => {
      const res = await get(tokens.ownerA, UNKNOWN_ID).expect(404);
      expect(res.body).toEqual({
        statusCode: 404,
        message: 'Commodity not found',
      });
      await get(tokens.ownerA, 'not-a-uuid').expect(400);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /commodities (list)', () => {
    let shop: { tenantId: string; token: string };

    beforeAll(async () => {
      shop = await newShop();
      for (const body of [
        { name: 'Gandum', nameUr: 'گندم', category: 'grain' },
        { name: 'Chawal', nameUr: 'چاول', category: 'Grain' },
        { name: 'Kapas', nameUr: 'کپاس', category: 'fibre' },
        { name: 'Sarson', nameUr: 'سرسوں', category: 'oilseed' },
        { name: 'Til 100%_x', category: 'oilseed', isActive: false },
      ]) {
        await seed(body, shop.token);
      }
    });

    it('returns { data, meta } with the defaults (page 1, limit 20, by name)', async () => {
      const res = await list(shop.token).expect(200);

      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 5 });
      expect(namesOf(res)).toEqual([
        'Chawal',
        'Gandum',
        'Kapas',
        'Sarson',
        'Til 100%_x',
      ]);
    });

    it('pages through the list without gaps or repeats', async () => {
      const pages = await Promise.all(
        [1, 2, 3].map((page) => list(shop.token, { page, limit: 2 })),
      );

      expect(pages.map((p) => p.body.meta.total as number)).toEqual([5, 5, 5]);
      expect(pages.flatMap(namesOf)).toEqual([
        'Chawal',
        'Gandum',
        'Kapas',
        'Sarson',
        'Til 100%_x',
      ]);
    });

    it('sorts by name, -name, createdAt and -createdAt', async () => {
      const by = async (sort: string) =>
        namesOf(await list(shop.token, { sort }).expect(200));
      const created = ['Gandum', 'Chawal', 'Kapas', 'Sarson', 'Til 100%_x'];

      expect(await by('-name')).toEqual([...(await by('name'))].reverse());
      expect(await by('createdAt')).toEqual(created);
      expect(await by('-createdAt')).toEqual([...created].reverse());
    });

    it('filters by active=true / active=false; no filter shows both', async () => {
      const active = await list(shop.token, { active: 'true' }).expect(200);
      const inactive = await list(shop.token, { active: 'false' }).expect(200);

      expect(active.body.meta.total).toBe(4);
      expect(namesOf(inactive)).toEqual(['Til 100%_x']);
    });

    it('filters by category (any case)', async () => {
      const res = await list(shop.token, { category: 'GRAIN' }).expect(200);

      expect(namesOf(res)).toEqual(['Chawal', 'Gandum']);
    });

    it('search matches the name or the Urdu name, any case and position', async () => {
      expect(namesOf(await list(shop.token, { search: 'AND' }))).toEqual([
        'Gandum',
      ]);
      expect(namesOf(await list(shop.token, { search: 'چاول' }))).toEqual([
        'Chawal',
      ]);
    });

    it('search combines with category and active', async () => {
      const res = await list(shop.token, {
        search: 's',
        category: 'oilseed',
        active: 'true',
      }).expect(200);

      expect(namesOf(res)).toEqual(['Sarson']);
    });

    it('"%" and "_" are literal, not wildcards', async () => {
      expect(namesOf(await list(shop.token, { search: '%' }))).toEqual([
        'Til 100%_x',
      ]);
      expect(namesOf(await list(shop.token, { search: '0%_' }))).toEqual([
        'Til 100%_x',
      ]);
      expect((await list(shop.token, { search: 'a_d' })).body.meta.total).toBe(
        0,
      );
    });

    it('bad query values → 400', async () => {
      for (const query of [
        { page: '0' },
        { limit: '101' },
        { active: 'yes' },
        { sort: 'price' },
      ]) {
        await list(shop.token, query).expect(400);
      }
    });

    /* -------------------------------------------------------------- */
    describe('GET /commodities/lookup', () => {
      it('active commodities only, by name, default limit 10, without q', async () => {
        const res = await lookup(shop.token).expect(200);

        expect(namesOf(res)).toEqual(['Chawal', 'Gandum', 'Kapas', 'Sarson']);
      });

      it('names starting with q first, then the rest by name', async () => {
        await seed({ name: 'Sabzi' }, shop.token);
        try {
          const res = await lookup(shop.token, { q: 'k' }).expect(200);
          // Kapas starts with k; nothing else has a k.
          expect(namesOf(res)).toEqual(['Kapas']);

          const ranked = await lookup(shop.token, { q: 'ch' }).expect(200);
          expect(namesOf(ranked)).toEqual(['Chawal']);

          const mixed = await lookup(shop.token, { q: 'a' }).expect(200);
          // None starts with "a": all matches by name.
          expect(namesOf(mixed)).toEqual([
            'Chawal',
            'Gandum',
            'Kapas',
            'Sabzi',
            'Sarson',
          ]);

          const s = await lookup(shop.token, { q: 's' }).expect(200);
          // Sabzi and Sarson start with s; Kapas only contains it.
          expect(namesOf(s)).toEqual(['Sabzi', 'Sarson', 'Kapas']);
        } finally {
          await fx.db
            .delete(commodities)
            .where(
              and(
                eq(commodities.tenantId, shop.tenantId),
                eq(commodities.name, 'Sabzi'),
              ),
            );
        }
      });

      it('finds by the Urdu name', async () => {
        const res = await lookup(shop.token, { q: 'کپ' }).expect(200);

        expect(namesOf(res)).toEqual(['Kapas']);
      });

      it('respects limit; above 50 → 400', async () => {
        expect(namesOf(await lookup(shop.token, { limit: 2 }))).toEqual([
          'Chawal',
          'Gandum',
        ]);
        await lookup(shop.token, { limit: 51 }).expect(400);
      });

      it('"%" is literal', async () => {
        expect((await lookup(shop.token, { q: '%' })).body.data).toEqual([]);
      });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('lookup charges (commodity override or shop default)', () => {
    let shop: { tenantId: string; token: string };
    let items: Record<string, CommodityLookupItem>;

    beforeAll(async () => {
      shop = await newShop();
      await fx.db.insert(tenantSettings).values({
        tenantId: shop.tenantId,
        defaultCommissionPct: '2.50',
        marketFeePct: '1.00',
        labourPerBag: '20.00',
      });
      await seed({ name: 'Plain' }, shop.token);
      await seed(
        {
          name: 'Override',
          defaultUnit: 'bag',
          bagWeightKg: '100',
          commissionPct: '3',
        },
        shop.token,
      );
      await seed(
        {
          name: 'Zero',
          commissionPct: '0',
          marketFeePct: '0',
          labourPerBag: '0',
        },
        shop.token,
      );
      const res = await lookup(shop.token).expect(200);
      items = Object.fromEntries(
        (res.body.data as CommodityLookupItem[]).map((i) => [i.name, i]),
      );
    });

    it('returns only the picker fields and the charges that apply', () => {
      expect(items.Override).toEqual({
        id: expect.stringMatching(UUID),
        name: 'Override',
        nameUr: null,
        defaultUnit: 'bag',
        bagWeightKg: '100.000',
        charges: {
          commissionPct: '3.00',
          marketFeePct: '1.00',
          labourPerBag: '20.00',
        },
      });
    });

    it('nothing set → the shop defaults', () => {
      expect(items.Plain.charges).toEqual({
        commissionPct: '2.50',
        marketFeePct: '1.00',
        labourPerBag: '20.00',
      });
    });

    it('"0" on the commodity overrides the default (no charge on this item)', () => {
      expect(items.Zero.charges).toEqual({
        commissionPct: '0.00',
        marketFeePct: '0.00',
        labourPerBag: '0.00',
      });
    });

    it('clearing an override (null) falls back to the shop default again', async () => {
      await patch(shop.token, items.Override.id, {
        commissionPct: null,
      }).expect(200);

      const res = await lookup(shop.token, { q: 'Override' }).expect(200);

      expect(
        (res.body.data as CommodityLookupItem[])[0].charges.commissionPct,
      ).toBe('2.50');
    });

    it('a shop without a settings row uses 0 for every default', async () => {
      const bare = await newShop();
      await seed({ name: 'Bare' }, bare.token);

      const res = await lookup(bare.token).expect(200);

      expect((res.body.data as CommodityLookupItem[])[0].charges).toEqual({
        commissionPct: '0.00',
        marketFeePct: '0.00',
        labourPerBag: '0.00',
      });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('PATCH /commodities/:id', () => {
    it('updates the sent fields only and writes an update audit row', async () => {
      const commodity = await seed({ category: 'grain' });

      const res = await patch(tokens.manager, commodity.id, {
        nameUr: 'گندم',
        bagWeightKg: '100',
        commissionPct: '2.75',
      }).expect(200);

      expect(res.body).toMatchObject({
        name: commodity.name,
        category: 'grain',
        nameUr: 'گندم',
        bagWeightKg: '100.000',
        commissionPct: '2.75',
      });
      const rows = await auditOf(commodity.id);
      expect(rows.map((r) => r.action)).toEqual(['create', 'update']);
      expect(rows[1]).toMatchObject({ userId: users.manager });
      // Only the changed fields are logged.
      expect(rows[1].after).toMatchObject({
        nameUr: 'گندم',
        bagWeightKg: '100.000',
        commissionPct: '2.75',
      });
      expect(rows[1].after).not.toHaveProperty('category');
    });

    it('clears optional fields with null or ""', async () => {
      const commodity = await seed({
        nameUr: 'x',
        bagWeightKg: '40',
        marketFeePct: '1',
        labourPerBag: '10',
      });

      const res = await patch(tokens.ownerA, commodity.id, {
        nameUr: null,
        bagWeightKg: '',
        marketFeePct: null,
        labourPerBag: '',
      }).expect(200);

      expect(res.body).toMatchObject({
        nameUr: null,
        bagWeightKg: null,
        marketFeePct: null,
        labourPerBag: null,
      });
    });

    it('an empty body changes nothing', async () => {
      const commodity = await seed();

      const res = await patch(tokens.ownerA, commodity.id, {}).expect(200);

      expect(res.body).toEqual(commodity);
      expect(await auditOf(commodity.id)).toHaveLength(1);
    });

    it('can deactivate a commodity (then it leaves the lookup)', async () => {
      const commodity = await seed({ name: `Seasonal ${uniq()}` });

      await patch(tokens.ownerA, commodity.id, { isActive: false }).expect(200);

      const res = await lookup(tokens.ownerA, { q: commodity.name });
      expect(res.body.data).toEqual([]);
    });

    it('bad fields → 400, nothing changed', async () => {
      const commodity = await seed();

      await patch(tokens.ownerA, commodity.id, {
        bagWeightKg: '-1',
      }).expect(400);

      expect((await commodityRow(commodity.id)).bagWeightKg).toBeNull();
    });

    it('unknown id → 404', async () => {
      await patch(tokens.ownerA, UNKNOWN_ID, { name: 'Nobody' }).expect(404);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('duplicate names', () => {
    it('same name twice in one shop → 409 NAME_TAKEN on create', async () => {
      const name = `Dup ${uniq()}`;
      await seed({ name });

      const res = await create(tokens.ownerA, { name: `  ${name} ` }).expect(
        409,
      );

      expect(res.body).toEqual({
        statusCode: 409,
        message: NAME_TAKEN_MSG,
        code: 'NAME_TAKEN',
        errors: [{ field: 'name', message: NAME_TAKEN_MSG }],
      });
    });

    it('a 409 on create writes nothing (row or audit)', async () => {
      const name = `Dup Audit ${uniq()}`;
      await seed({ name });

      await create(tokens.ownerA, { name }).expect(409);

      const rows = await fx.db
        .select()
        .from(commodities)
        .where(
          and(eq(commodities.tenantId, shopA), eq(commodities.name, name)),
        );
      expect(rows).toHaveLength(1);
      expect(await auditOf(rows[0].id)).toHaveLength(1);
    });

    it('same name in another shop → allowed', async () => {
      const name = `Shared ${uniq()}`;
      await seed({ name });

      await seed({ name }, tokens.ownerB);
    });

    it("renaming to another commodity's name → 409 NAME_TAKEN, nothing changed", async () => {
      const first = await seed();
      const second = await seed();

      const res = await patch(tokens.ownerA, second.id, {
        name: first.name,
        category: 'grain',
      }).expect(409);

      expect(res.body.code).toBe('NAME_TAKEN');
      expect(await commodityRow(second.id)).toMatchObject({
        name: second.name,
        category: null,
      });
    });

    it('renaming to its own name is fine', async () => {
      const commodity = await seed();

      await patch(tokens.ownerA, commodity.id, {
        name: commodity.name,
      }).expect(200);
    });

    it('names differing only in case are different names (plain unique index, as designed)', async () => {
      const name = `Case ${uniq()}`;
      await seed({ name });

      await seed({ name: name.toUpperCase() });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('DELETE /commodities/:id', () => {
    it('soft deletes: 204, then 404 and gone from list and lookup', async () => {
      const commodity = await seed({ name: `Gone ${uniq()}` });

      await remove(tokens.ownerA, commodity.id).expect(204);

      await get(tokens.ownerA, commodity.id).expect(404);
      await patch(tokens.ownerA, commodity.id, { name: 'Back' }).expect(404);
      await remove(tokens.ownerA, commodity.id).expect(404);
      const listed = await list(tokens.ownerA, { search: commodity.name });
      expect(listed.body.meta.total).toBe(0);
      const found = await lookup(tokens.ownerA, { q: commodity.name });
      expect(found.body.data).toEqual([]);

      const row = await commodityRow(commodity.id);
      expect(row.deletedAt).not.toBeNull();
      const audits = await auditOf(commodity.id);
      expect(audits.map((r) => r.action)).toEqual(['create', 'delete']);
    });

    it("a deleted commodity's name still blocks a new one (unique index includes deleted rows)", async () => {
      const commodity = await seed();
      await remove(tokens.ownerA, commodity.id).expect(204);

      const res = await create(tokens.ownerA, { name: commodity.name }).expect(
        409,
      );

      expect(res.body.code).toBe('NAME_TAKEN');
    });

    it('the owner restores a deleted commodity via /records/commodities/:id/restore', async () => {
      const commodity = await seed();
      await remove(tokens.ownerA, commodity.id).expect(204);

      const res = await restore(tokens.ownerA, commodity.id).expect(200);

      expect(res.body).toEqual({ id: commodity.id, restored: true });
      await get(tokens.ownerA, commodity.id).expect(200);
      expect((await auditOf(commodity.id)).map((a) => a.action)).toEqual([
        'create',
        'delete',
        'restore',
      ]);
    });

    it('managers cannot restore; another shop cannot restore', async () => {
      const commodity = await seed();
      await remove(tokens.ownerA, commodity.id).expect(204);

      await restore(tokens.manager, commodity.id).expect(403);
      await restore(tokens.ownerB, commodity.id).expect(404);
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

    /** View: every shop role; manage: manager+; delete: owner. */
    const expected = (role: Role, allowed: Role[], ok: number): number => {
      if (role === 'none') return 401;
      return allowed.includes(role) ? ok : 403;
    };
    const VIEW: Role[] = ['owner', 'manager', 'operator'];
    const MANAGE: Role[] = ['owner', 'manager'];

    it.each(ROLES)('GET /commodities as %s', async (role) => {
      await list(tokenOf(role)).expect(expected(role, VIEW, 200));
    });

    it.each(ROLES)('GET /commodities/lookup as %s', async (role) => {
      await lookup(tokenOf(role), { q: 'a' }).expect(expected(role, VIEW, 200));
    });

    it.each(ROLES)('GET /commodities/:id as %s', async (role) => {
      const commodity = await seed();
      await get(tokenOf(role), commodity.id).expect(expected(role, VIEW, 200));
    });

    it.each(ROLES)('POST /commodities as %s', async (role) => {
      const name = `Perm ${role} ${uniq()}`;
      const status = expected(role, MANAGE, 201);

      const res = await create(tokenOf(role), { name }).expect(status);

      if (status === 403) {
        expect(res.body).toEqual({ statusCode: 403, message: NO_ACCESS });
      }
      const rows = await fx.db
        .select()
        .from(commodities)
        .where(eq(commodities.name, name));
      expect(rows).toHaveLength(status === 201 ? 1 : 0);
    });

    it.each(ROLES)('PATCH /commodities/:id as %s', async (role) => {
      const commodity = await seed();
      const status = expected(role, MANAGE, 200);

      const res = await patch(tokenOf(role), commodity.id, {
        category: 'changed',
      }).expect(status);

      if (status === 403) {
        expect(res.body).toEqual({ statusCode: 403, message: NO_ACCESS });
      }
      expect((await commodityRow(commodity.id)).category).toBe(
        status === 200 ? 'changed' : null,
      );
    });

    it.each(ROLES)('DELETE /commodities/:id as %s', async (role) => {
      const commodity = await seed();
      const status = expected(role, ['owner'], 204);

      await remove(tokenOf(role), commodity.id).expect(status);

      const row = await commodityRow(commodity.id);
      expect(row.deletedAt === null).toBe(status !== 204);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('tenant isolation', () => {
    let commodityB: Commodity;
    const nameB = `Shop B Only ${uniq()}`;

    beforeAll(async () => {
      commodityB = await seed(
        { name: nameB, nameUr: 'صرف بی', commissionPct: '4' },
        tokens.ownerB,
      );
    });

    it("shop A cannot read shop B's commodity → 404", async () => {
      const res = await get(tokens.ownerA, commodityB.id).expect(404);

      expect(res.body).toEqual({
        statusCode: 404,
        message: 'Commodity not found',
      });
      await get(tokens.ownerB, commodityB.id).expect(200);
    });

    it("shop A cannot update shop B's commodity → 404, unchanged", async () => {
      await patch(tokens.ownerA, commodityB.id, {
        name: 'Hijacked',
        commissionPct: '0',
      }).expect(404);

      expect(await commodityRow(commodityB.id)).toMatchObject({
        name: nameB,
        commissionPct: '4.00',
        tenantId: shopB,
      });
    });

    it("shop A cannot delete shop B's commodity → 404, not deleted", async () => {
      await remove(tokens.ownerA, commodityB.id).expect(404);

      expect((await commodityRow(commodityB.id)).deletedAt).toBeNull();
    });

    it("list and lookup never show shop B's commodities (by name or Urdu name)", async () => {
      for (const search of [nameB, 'صرف بی', 'Shop B Only']) {
        const listed = await list(tokens.ownerA, { search }).expect(200);
        expect(listed.body.meta.total).toBe(0);
        const found = await lookup(tokens.ownerA, { q: search }).expect(200);
        expect(found.body.data).toEqual([]);
      }
      const all = await list(tokens.ownerA, { limit: 100 }).expect(200);
      expect(
        (all.body.data as { id: string }[]).map((c) => c.id),
      ).not.toContain(commodityB.id);
    });

    it("shop B's name does not block shop A (409 is per shop)", async () => {
      await seed({ name: nameB });
    });

    it('tenantId / tenant_id in the body are ignored on create', async () => {
      const res = await create(tokens.ownerA, {
        name: `Smuggler ${uniq()}`,
        tenantId: shopB,
        tenant_id: shopB,
      }).expect(201);

      expect((await commodityRow(res.body.id as string)).tenantId).toBe(shopA);
    });

    it('tenant_id in the body is ignored on update', async () => {
      const commodity = await seed();

      await patch(tokens.ownerA, commodity.id, {
        tenant_id: shopB,
        tenantId: shopB,
        category: 'stays in A',
      }).expect(200);

      expect(await commodityRow(commodity.id)).toMatchObject({
        tenantId: shopA,
        category: 'stays in A',
      });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('default list for new shops', () => {
    it('a shop created by the super-admin starts with the default commodities', async () => {
      const res = await as(http().post('/admin/tenants'), tokens.superAdmin)
        .send({
          name: `Default List Shop ${uniq()}`,
          city: 'Okara',
          phone: fx.phone(),
          owner: { name: 'Default Owner', phone: fx.phone() },
        })
        .expect(201);
      const tenantId = String(res.body.tenant.id);
      fx.trackTenant(tenantId);

      const rows = await fx.db
        .select()
        .from(commodities)
        .where(eq(commodities.tenantId, tenantId))
        .orderBy(asc(commodities.name));

      expect(rows.map((r) => [r.name, r.nameUr, r.category])).toEqual(
        DEFAULT_COMMODITIES.map((c) => [c.name, c.nameUr, c.category]).sort(
          (a, b) => a[0].localeCompare(b[0]),
        ),
      );
      for (const row of rows) {
        expect(row).toMatchObject({
          defaultUnit: 'maund',
          bagWeightKg: null,
          commissionPct: null,
          marketFeePct: null,
          labourPerBag: null,
          isActive: true,
          deletedAt: null,
        });
      }
    });

    it('existing shops are not back-filled (shop A has only its own)', async () => {
      const res = await list(tokens.ownerA, { search: 'Gandum' }).expect(200);

      // Only the one this suite created ("Gandum" in POST /commodities).
      expect(namesOf(res)).toEqual(['Gandum']);
      const kapas = await list(tokens.ownerA, { search: 'Kapas' }).expect(200);
      expect(kapas.body.meta.total).toBe(0);
    });
  });
});
