import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication, Logger } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { type PoolClient } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  auditLogs,
  refreshTokens,
  tenantSettings,
  tenants,
  users,
} from '../src/database/schema';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import { slugify } from '../src/modules/tenants/tenants.service';
import type {
  TenantDetail,
  TenantSummary,
} from '../src/modules/tenants/tenants.dto';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';

const BASE = '/admin/tenants';
/** Unique per run, so searches only ever see this suite's shops. */
// Letters only: digits in the tag would also match test shops' phone numbers.
const TAG = `zq${randomBytes(3)
  .toString('hex')
  .replace(/\d/g, (d) => 'ghijklmnop'[Number(d)])}`;

/** `03991234567` → `+92 399 1234567` (how people type it). */
const intl = (phone: string) => `+92 ${phone.slice(1, 4)} ${phone.slice(4)}`;
/** `03991234567` → `0399 123 4567`. */
const spaced = (phone: string) =>
  `${phone.slice(0, 4)} ${phone.slice(4, 7)} ${phone.slice(7)}`;

interface Session {
  accessToken: string;
  cookie: string;
}

function refreshCookie(res: request.Response): string {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = header?.find((c) => c.startsWith('refresh_token='));
  if (!cookie) throw new Error('no refresh cookie');
  return cookie.split(';')[0];
}

describe('Shops admin /admin/tenants (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;
  let admin: string;
  let adminId: string;
  let seq = 0;

  const http = () => request(app.getHttpServer());
  /** `token` defaults to the super-admin's; `null` sends none. */
  const as = (req: request.Test, token: string | null) =>
    token ? req.set('Authorization', `Bearer ${token}`) : req;
  const get = (url: string, token: string | null = admin) =>
    as(http().get(url), token);
  const post = (url: string, body?: object, token: string | null = admin) =>
    as(http().post(url), token).send(body);
  const patch = (url: string, body: object, token: string | null = admin) =>
    as(http().patch(url), token).send(body);

  async function login(identifier: string, password = PASSWORD) {
    const res = await http().post('/auth/login').send({ identifier, password });
    return res;
  }

  async function session(identifier: string, password = PASSWORD) {
    const res = await login(identifier, password);
    expect(res.status).toBe(200);
    return {
      accessToken: res.body.accessToken as string,
      cookie: refreshCookie(res),
    } satisfies Session;
  }

  /** A valid create body with fresh phones; `over` replaces top-level keys. */
  function shopBody(over: Record<string, unknown> = {}) {
    seq += 1;
    return {
      name: `Grain Shop ${TAG} ${seq}`,
      city: 'Okara',
      phone: fx.phone(),
      owner: { name: `Owner ${TAG} ${seq}`, phone: fx.phone() },
      ...over,
    };
  }

  /** POST and remember the shop for cleanup. */
  async function createShop(body: object = shopBody()) {
    const res = await post(BASE, body);
    if (res.status === 201) fx.trackTenant(String(res.body.tenant.id));
    return res;
  }

  async function createOk(body: object = shopBody()) {
    const res = await createShop(body);
    expect(res.status).toBe(201);
    return res.body as {
      tenant: TenantDetail;
      temporaryPassword: string;
    };
  }

  const countOf = async (
    table: typeof tenants | typeof tenantSettings | typeof users,
  ) => (await fx.db.select({ n: count() }).from(table))[0].n;

  const settingsOf = async (tenantId: string) =>
    fx.db
      .select()
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));

  const auditOf = (tenantId: string) =>
    fx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, tenantId))
      .orderBy(asc(auditLogs.id));

  const tenantsNamed = (...names: string[]) =>
    fx.db.select().from(tenants).where(inArray(tenants.name, names));

  const usersWithPhone = (phone: string) =>
    fx.db.select().from(users).where(eq(users.phone, phone));

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
    admin = (await session(superAdmin.phone)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await fx.cleanup();
  });

  /* ---------------------------------------------------------------- */
  describe('POST /admin/tenants', () => {
    it('creates the shop (trial), its owner and default settings; phones normalised', async () => {
      const shopPhone = fx.phone();
      const ownerPhone = fx.phone();
      const name = `Haji Grain ${TAG}`;

      const { tenant, temporaryPassword } = await createOk({
        name,
        city: 'Okara',
        address: 'Shop 12, Grain Market',
        phone: intl(shopPhone),
        email: `shop.${TAG}@example.com`,
        owner: {
          name: 'Haji Aslam',
          phone: `${ownerPhone.slice(0, 4)}-${ownerPhone.slice(4)}`,
          email: `Aslam.${TAG}@Example.COM`,
        },
      });

      expect(tenant).toMatchObject({
        name,
        slug: slugify(name),
        city: 'Okara',
        address: 'Shop 12, Grain Market',
        phone: shopPhone,
        email: `shop.${TAG}@example.com`,
        logoUrl: null,
        ownerName: 'Haji Aslam',
        status: 'trial',
        userCount: 1,
        owner: {
          name: 'Haji Aslam',
          phone: ownerPhone,
          email: `aslam.${TAG}@example.com`,
          isActive: true,
          mustChangePassword: true,
        },
      });
      expect(tenant.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Date(tenant.createdAt).toISOString()).toBe(tenant.createdAt);
      expect(temporaryPassword).toMatch(
        /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{12}$/,
      );

      const [owner] = await usersWithPhone(ownerPhone);
      expect(owner).toMatchObject({
        id: tenant.owner!.id,
        tenantId: tenant.id,
        role: 'owner',
        mustChangePassword: true,
        isActive: true,
      });
      expect(owner.passwordHash).toMatch(/^\$argon2/);
      expect(owner.passwordHash).not.toContain(temporaryPassword);

      expect(await settingsOf(tenant.id)).toEqual([
        expect.objectContaining({
          tenantId: tenant.id,
          displayName: name,
          parchiFooter: null,
          defaultCommissionPct: '0.00',
          marketFeePct: '0.00',
          labourPerBag: '0.00',
          defaultUnit: 'kg',
          maundKg: '40.000',
          billPrefix: null,
          financialYearStart: null,
          language: 'en',
        }),
      ]);
    });

    it('the new owner can log in with the temporary password and must change it', async () => {
      const body = shopBody();
      const { tenant, temporaryPassword } = await createOk(body);

      const owner = await session(body.owner.phone, temporaryPassword);
      const me = await get('/auth/me', owner.accessToken).expect(200);

      expect(me.body).toMatchObject({
        id: tenant.owner!.id,
        role: 'owner',
        tenantId: tenant.id,
        mustChangePassword: true,
      });
      // The old fixture password is not the owner's password.
      expect((await login(body.owner.phone)).status).toBe(401);
    });

    it('writes create audit rows for tenants, users and tenant_settings, password hash redacted', async () => {
      const { tenant } = await createOk();

      const rows = await auditOf(tenant.id);

      expect(
        rows.map((r) => [r.entity, r.entityId, r.action, r.userId]),
      ).toEqual([
        ['tenants', tenant.id, 'create', adminId],
        ['users', tenant.owner!.id, 'create', adminId],
        ['tenant_settings', tenant.id, 'create', adminId],
      ]);
      const [shop, owner, settings] = rows;
      expect(shop.before).toBeNull();
      expect(shop.after).toMatchObject({ id: tenant.id, status: 'trial' });
      expect(owner.after).toMatchObject({
        id: tenant.owner!.id,
        role: 'owner',
        passwordHash: '[REDACTED]',
      });
      expect(JSON.stringify(owner.after)).not.toMatch(/\$argon2/);
      expect(settings.after).toMatchObject({ displayName: tenant.name });
    });

    it('a repeated name gets a unique slug (-2, -3)', async () => {
      const name = `Same Name ${TAG}`;

      const first = await createOk(shopBody({ name }));
      const second = await createOk(shopBody({ name }));
      const third = await createOk(shopBody({ name }));

      expect(first.tenant.slug).toBe(slugify(name));
      expect(second.tenant.slug).toBe(`${slugify(name)}-2`);
      expect(third.tenant.slug).toBe(`${slugify(name)}-3`);
    });

    it('a name with no Latin letters gets the "shop" slug base', async () => {
      const { tenant } = await createOk(shopBody({ name: 'غلہ منڈی اوکاڑہ' }));

      expect(tenant.slug).toMatch(/^shop(-\d+)?$/);
    });

    describe('owner phone already has an account', () => {
      it.each([
        ['as stored', (p: string) => p],
        ['typed as +92 3xx …', intl],
      ])(
        '409 PHONE_TAKEN (%s) and nothing is created',
        async (_label, typed) => {
          const existing = await fx.user('operator', await fx.tenant());
          const body = shopBody();
          body.owner.phone = typed(existing.phone);
          const before = await Promise.all([
            countOf(tenants),
            countOf(tenantSettings),
            countOf(users),
          ]);

          const res = await createShop(body);

          expect(res.status).toBe(409);
          expect(res.body).toEqual({
            statusCode: 409,
            message: 'This phone already has an account',
            code: 'PHONE_TAKEN',
            errors: [
              {
                field: 'owner.phone',
                message: 'This phone already has an account',
              },
            ],
          });
          expect(
            await Promise.all([
              countOf(tenants),
              countOf(tenantSettings),
              countOf(users),
            ]),
          ).toEqual(before);
          expect(await tenantsNamed(body.name)).toEqual([]);
        },
      );

      it("the existing user's phone may belong to a super-admin too", async () => {
        const other = await fx.user('super_admin', null);
        const body = shopBody();
        body.owner.phone = spaced(other.phone);

        const res = await createShop(body);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PHONE_TAKEN');
      });
    });

    it('owner email already used (any case) → 409 EMAIL_TAKEN, nothing created', async () => {
      const existing = await fx.user('manager', await fx.tenant());
      const body = shopBody();
      const owner = { ...body.owner, email: existing.email!.toUpperCase() };
      const before = await countOf(tenants);

      const res = await createShop({ ...body, owner });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        code: 'EMAIL_TAKEN',
        errors: [{ field: 'owner.email' }],
      });
      expect(await countOf(tenants)).toBe(before);
      expect(await usersWithPhone(body.owner.phone)).toEqual([]);
    });

    it('bad body → 400 with field errors and nothing created', async () => {
      const before = await countOf(tenants);

      const res = await createShop({
        name: 'x',
        phone: '0300 1234567',
        owner: { phone: 'call me' },
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        message: 'Validation failed',
      });
      const fields = (res.body.errors as { field: string }[]).map(
        (e) => e.field,
      );
      expect(fields).toEqual(
        expect.arrayContaining(['name', 'owner.phone', 'owner.name']),
      );
      expect(await countOf(tenants)).toBe(before);
    });

    it.each([
      ['missing everything', {}],
      ['no owner', { name: 'Okay Name', phone: '03001234567' }],
      [
        'bad emails',
        {
          name: 'Okay Name',
          phone: '03001234567',
          email: 'nope',
          owner: { name: 'Owner', phone: '03001234567', email: 'nope' },
        },
      ],
      [
        'name too long',
        {
          name: 'n'.repeat(121),
          phone: '03001234567',
          owner: { name: 'Owner', phone: '03001234567' },
        },
      ],
    ])('400 for %s', async (_label, body) => {
      const res = await createShop(body);

      expect(res.status).toBe(400);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    it('a tenant_id or status sent by the client is ignored', async () => {
      const other = await fx.tenant();
      const res = await createShop({
        ...shopBody(),
        tenant_id: other,
        status: 'active',
      });

      expect(res.status).toBe(201);
      expect(res.body.tenant.id).not.toBe(other);
      expect(res.body.tenant.status).toBe('trial');
    });
  });

  /* ---------------------------------------------------------------- */
  describe('create is all-or-nothing (real rollback)', () => {
    const FN = 'test_tenants_fail';
    let logError: jest.SpyInstance;

    // The forced failures are 500s; keep their stack traces out of the output.
    beforeAll(() => {
      logError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
    });
    afterAll(() => logError.mockRestore());

    async function withFailingTrigger(
      table: 'tenant_settings' | 'audit_logs',
      when: string,
      fn: () => Promise<void>,
    ) {
      await fx.pool.query(
        `create or replace function ${FN}() returns trigger language plpgsql
           as $$ begin raise exception 'forced failure for e2e'; end $$`,
      );
      await fx.pool.query(
        `create trigger ${FN} before insert on ${table}
           for each row when (${when}) execute function ${FN}()`,
      );
      try {
        await fn();
      } finally {
        await fx.pool.query(`drop trigger if exists ${FN} on ${table}`);
        await fx.pool.query(`drop function if exists ${FN}()`);
      }
    }

    async function expectNothingCreated(
      body: ReturnType<typeof shopBody>,
      before: number[],
    ) {
      expect(await tenantsNamed(body.name)).toEqual([]);
      expect(await usersWithPhone(body.owner.phone)).toEqual([]);
      expect(
        await Promise.all([
          countOf(tenants),
          countOf(tenantSettings),
          countOf(users),
        ]),
      ).toEqual(before);
    }

    it('settings insert fails after tenant + owner inserts → 500, nothing kept', async () => {
      const body = shopBody({ name: `Rollback Settings ${TAG}` });
      const before = await Promise.all([
        countOf(tenants),
        countOf(tenantSettings),
        countOf(users),
      ]);

      await withFailingTrigger(
        'tenant_settings',
        `new.display_name = '${body.name}'`,
        async () => {
          const res = await createShop(body);
          expect(res.status).toBe(500);
          expect(res.body).toEqual({
            statusCode: 500,
            message: 'Internal server error',
          });
        },
      );

      await expectNothingCreated(body, before);
    });

    it('the last audit insert fails → 500, nothing kept (audit rows included)', async () => {
      const body = shopBody({ name: `Rollback Audit ${TAG}` });
      const before = await Promise.all([
        countOf(tenants),
        countOf(tenantSettings),
        countOf(users),
      ]);
      const audits = await fx.db.select({ n: count() }).from(auditLogs);

      await withFailingTrigger(
        'audit_logs',
        `new.entity = 'tenant_settings' and new.after->>'displayName' = '${body.name}'`,
        async () => {
          expect((await createShop(body)).status).toBe(500);
        },
      );

      await expectNothingCreated(body, before);
      expect(await fx.db.select({ n: count() }).from(auditLogs)).toEqual(
        audits,
      );
    });

    /**
     * Holds an EXCLUSIVE lock on tenant_settings so concurrent creates stop
     * inside their transactions, after their tenant inserts; releases it once
     * `waiting` backends are blocked, then awaits the requests.
     */
    async function race(bodies: object[], waiting: number) {
      const locker: PoolClient = await fx.pool.connect();
      try {
        await locker.query('begin');
        await locker.query('lock table tenant_settings in exclusive mode');
        const pending = bodies.map((b) => createShop(b).then((r) => r));

        const deadline = Date.now() + 15_000;
        for (;;) {
          const { rows } = await fx.pool.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity
              where datname = current_database()
                and wait_event_type = 'Lock'
                and query ilike 'insert into%'`,
          );
          if (rows[0].n >= waiting) break;
          if (Date.now() > deadline) throw new Error('creates never blocked');
          await new Promise((r) => setTimeout(r, 50));
        }
        await locker.query('commit');
        return await Promise.all(pending);
      } finally {
        await locker.query('rollback').catch(() => undefined);
        locker.release();
      }
    }

    it('two concurrent creates with the same owner phone: one 201, one 409; the loser keeps nothing', async () => {
      const ownerPhone = fx.phone();
      const a = shopBody();
      const b = shopBody();
      a.owner.phone = ownerPhone;
      b.owner.phone = intl(ownerPhone);
      const settingsBefore = await countOf(tenantSettings);

      // Winner waits on the lock, loser waits on the winner's owner row.
      const results = await race([a, b], 2);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body).toMatchObject({
        code: 'PHONE_TAKEN',
        errors: [{ field: 'owner.phone' }],
      });
      const kept = await tenantsNamed(a.name, b.name);
      expect(kept).toHaveLength(1);
      expect(await usersWithPhone(ownerPhone)).toEqual([
        expect.objectContaining({ tenantId: kept[0].id, role: 'owner' }),
      ]);
      expect(await countOf(tenantSettings)).toBe(settingsBefore + 1);
    });

    // BUG tenants.service.ts:216-221 — both requests pass the phone check and
    // pick the same slug; the loser hits `tenants_slug_unique` (not phone or
    // email), so it is rethrown as a 500 instead of 409 PHONE_TAKEN. Drop
    // `.failing` once fixed.
    it('a double-submitted create (same body twice at once): one 201, one 409', async () => {
      const body = shopBody();

      const results = await race([body, body], 2);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await tenantsNamed(body.name)).toHaveLength(1);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET /admin/tenants (list)', () => {
    const L = `${TAG}L`;
    let basmati: TenantDetail;
    let wheat: TenantDetail;
    let promo: TenantDetail;
    let deleted: TenantDetail;
    let basmatiOwnerPhone: string;
    let wheatShopPhone: string;

    const list = async (query: Record<string, string | number>) => {
      const res = await get(BASE).query(query).expect(200);
      return res.body as {
        data: TenantSummary[];
        meta: { page: number; limit: number; total: number };
      };
    };
    const names = (body: { data: TenantSummary[] }) =>
      body.data.map((t) => t.name);

    beforeAll(async () => {
      basmatiOwnerPhone = fx.phone();
      wheatShopPhone = fx.phone();
      basmati = (
        await createOk({
          name: `Basmati House ${L}`,
          city: `Okara${L}`,
          phone: fx.phone(),
          owner: { name: `Aslam ${L}`, phone: basmatiOwnerPhone },
        })
      ).tenant;
      wheat = (
        await createOk({
          name: `Wheat Mart ${L}`,
          city: `Sahiwal${L}`,
          phone: wheatShopPhone,
          owner: { name: `Bashir ${L}`, phone: fx.phone() },
        })
      ).tenant;
      promo = (
        await createOk({
          name: `Promo 50%_${L}`,
          city: null,
          phone: fx.phone(),
          owner: { name: `Kamran ${L}`, phone: fx.phone() },
        })
      ).tenant;
      deleted = (
        await createOk({
          name: `Closed Shop ${L}`,
          phone: fx.phone(),
          owner: { name: `Gone ${L}`, phone: fx.phone() },
        })
      ).tenant;
      await fx.db
        .update(tenants)
        .set({ deletedAt: new Date() })
        .where(eq(tenants.id, deleted.id));

      // Basmati: owner + manager + a soft-deleted operator → 2 users.
      await fx.user('manager', basmati.id);
      await fx.user('operator', basmati.id, { deletedAt: new Date() });

      await post(`${BASE}/${wheat.id}/suspend`).expect(200);
    });

    it('returns { data, meta } with summaries; soft-deleted shops are hidden', async () => {
      const body = await list({ search: L });

      expect(body.meta).toEqual({ page: 1, limit: 20, total: 3 });
      expect(names(body).sort()).toEqual(
        [basmati.name, wheat.name, promo.name].sort(),
      );
      const row = body.data.find((t) => t.id === basmati.id)!;
      expect(Object.keys(row).sort()).toEqual(
        [
          'id',
          'name',
          'slug',
          'city',
          'phone',
          'ownerName',
          'status',
          'userCount',
          'createdAt',
        ].sort(),
      );
      expect(names(body)).not.toContain(deleted.name);
    });

    it('userCount counts the shop’s users that are not deleted', async () => {
      const body = await list({ search: L });
      const byId = new Map(body.data.map((t) => [t.id, t.userCount]));

      expect(byId.get(basmati.id)).toBe(2);
      expect(byId.get(wheat.id)).toBe(1);
    });

    it('a soft-deleted shop is 404 by id', async () => {
      await get(`${BASE}/${deleted.id}`).expect(404);
    });

    it.each([
      ['shop name', () => `basmati HOUSE ${L}`, () => basmati],
      ['owner name', () => `aslam ${L}`.toUpperCase(), () => basmati],
      ['city', () => `sahiwal${L}`, () => wheat],
      ['shop phone as stored', () => wheatShopPhone, () => wheat],
      ['shop phone with spaces', () => spaced(wheatShopPhone), () => wheat],
      ['shop phone typed +92', () => intl(wheatShopPhone), () => wheat],
      ['owner phone as stored', () => basmatiOwnerPhone, () => basmati],
      [
        'owner phone with spaces',
        () => spaced(basmatiOwnerPhone),
        () => basmati,
      ],
      ['owner phone typed +92', () => intl(basmatiOwnerPhone), () => basmati],
      [
        'part of the owner phone',
        () => basmatiOwnerPhone.slice(2),
        () => basmati,
      ],
    ])('search by %s', async (_label, search, expected) => {
      const body = await list({ search: search() });

      expect(body.data.map((t) => t.id)).toEqual([expected().id]);
      expect(body.meta.total).toBe(1);
    });

    // BUG tenants.service.ts:318-320 — "+92 399 1234" (partial, with +92) gives
    // digits "923991234"; normalizePhone only rewrites 12-digit numbers, so
    // the pattern keeps the 92 and matches nothing, contrary to the comment.
    // Drop `.failing` once fixed.
    it('search by part of a phone typed with +92', async () => {
      // "+92 399 12345" — the 0 dropped, the last digits not typed yet.
      const body = await list({
        search: intl(basmatiOwnerPhone).slice(0, -2),
        limit: 100,
      });

      expect(body.data.map((t) => t.id)).toContain(basmati.id);
    });

    it('% and _ in the search are literal, not wildcards', async () => {
      const literal = await list({ search: `%_${L}` });
      expect(literal.data.map((t) => t.id)).toEqual([promo.id]);

      const percent = await list({ search: '%', limit: 100 });
      for (const t of percent.data) {
        expect(
          [t.name, t.ownerName, t.city, t.phone].some((f) => f?.includes('%')),
        ).toBe(true);
      }
      expect(percent.data.map((t) => t.id)).toContain(promo.id);

      const underscore = await list({ search: `${L.slice(0, 4)}_` });
      expect(underscore.meta.total).toBe(0);
    });

    it('filters by status (combined with search)', async () => {
      const suspended = await list({ search: L, status: 'suspended' });
      const trial = await list({ search: L, status: 'trial' });
      const active = await list({ search: L, status: 'active' });

      expect(suspended.data.map((t) => t.id)).toEqual([wheat.id]);
      expect(suspended.data[0].status).toBe('suspended');
      expect(trial.data.map((t) => t.id).sort()).toEqual(
        [basmati.id, promo.id].sort(),
      );
      expect(active.meta.total).toBe(0);
    });

    it('sorts by name and createdAt both ways (default -createdAt)', async () => {
      const created = [basmati, wheat, promo].map((t) => t.name);
      const byName = [...created].sort((a, b) => a.localeCompare(b, 'en'));

      expect(names(await list({ search: L }))).toEqual([...created].reverse());
      expect(names(await list({ search: L, sort: '-createdAt' }))).toEqual(
        [...created].reverse(),
      );
      expect(names(await list({ search: L, sort: 'createdAt' }))).toEqual(
        created,
      );
      expect(names(await list({ search: L, sort: 'name' }))).toEqual(byName);
      expect(names(await list({ search: L, sort: '-name' }))).toEqual(
        [...byName].reverse(),
      );
    });

    it('pages without overlap and reports the total', async () => {
      const p1 = await list({ search: L, limit: 2, page: 1, sort: 'name' });
      const p2 = await list({ search: L, limit: 2, page: 2, sort: 'name' });
      const p3 = await list({ search: L, limit: 2, page: 3, sort: 'name' });

      expect(p1.meta).toEqual({ page: 1, limit: 2, total: 3 });
      expect(p2.meta).toEqual({ page: 2, limit: 2, total: 3 });
      expect(p1.data).toHaveLength(2);
      expect(p2.data).toHaveLength(1);
      expect(p3.data).toEqual([]);
      expect(new Set([...names(p1), ...names(p2)]).size).toBe(3);
    });

    it.each([
      ['limit over 100', { limit: 101 }],
      ['limit 0', { limit: 0 }],
      ['page 0', { page: 0 }],
      ['unknown status', { status: 'closed' }],
      ['unknown sort', { sort: 'phone' }],
      ['search over 120 chars', { search: 'x'.repeat(121) }],
    ])('400 for %s', async (_label, query) => {
      const res = await get(BASE).query(query).expect(400);

      expect(res.body.errors.length).toBeGreaterThan(0);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('GET / PATCH /admin/tenants/:id', () => {
    let shop: TenantDetail;

    beforeAll(async () => {
      shop = (
        await createOk(
          shopBody({
            address: 'Old address',
            email: `old.${TAG}@example.com`,
          }),
        )
      ).tenant;
    });

    it('GET returns the detail with the owner', async () => {
      const res = await get(`${BASE}/${shop.id}`).expect(200);

      expect(res.body).toEqual(shop);
      expect(res.body.owner).toMatchObject({
        mustChangePassword: true,
        isActive: true,
      });
    });

    it('PATCH updates name, city and phone (normalised); other fields stay', async () => {
      const phone = fx.phone();

      const res = await patch(`${BASE}/${shop.id}`, {
        name: `Renamed ${TAG}`,
        city: 'Pakpattan',
        phone: intl(phone),
      }).expect(200);

      expect(res.body).toMatchObject({
        id: shop.id,
        name: `Renamed ${TAG}`,
        city: 'Pakpattan',
        phone,
        address: 'Old address',
        email: `old.${TAG}@example.com`,
        slug: shop.slug,
        status: shop.status,
      });
      expect(Date.parse(String(res.body.updatedAt))).toBeGreaterThan(
        new Date(shop.updatedAt).getTime(),
      );
      expect((await get(`${BASE}/${shop.id}`).expect(200)).body).toEqual(
        res.body,
      );
    });

    it('null clears the optional fields; logoUrl can be set', async () => {
      const res = await patch(`${BASE}/${shop.id}`, {
        city: null,
        address: null,
        email: null,
        logoUrl: 'https://cdn.example.com/logo.png',
      }).expect(200);

      expect(res.body).toMatchObject({
        city: null,
        address: null,
        email: null,
        logoUrl: 'https://cdn.example.com/logo.png',
      });

      const cleared = await patch(`${BASE}/${shop.id}`, {
        logoUrl: null,
      }).expect(200);
      expect(cleared.body.logoUrl).toBeNull();
    });

    it('an update writes one audit "update" row by the super-admin', async () => {
      const before = (await auditOf(shop.id)).length;

      await patch(`${BASE}/${shop.id}`, { name: `Audited ${TAG}` }).expect(200);

      const rows = (await auditOf(shop.id)).slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entity: 'tenants',
        entityId: shop.id,
        action: 'update',
        userId: adminId,
        after: expect.objectContaining({ name: `Audited ${TAG}` }),
      });
    });

    // BUG tenants.service.ts:238-245 — the audit row stores the whole row
    // before/after instead of only the changed fields (diffChanges()).
    // Drop `.failing` once fixed.
    it('the update audit row holds only the changed fields', async () => {
      const current = (await get(`${BASE}/${shop.id}`).expect(200)).body;
      const before = (await auditOf(shop.id)).length;

      await patch(`${BASE}/${shop.id}`, {
        name: `Only Name ${TAG}`,
        phone: current.phone,
      }).expect(200);

      const rows = (await auditOf(shop.id)).slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0].before).toEqual({ name: current.name });
      expect(rows[0].after).toEqual({ name: `Only Name ${TAG}` });
    });

    // BUG tenants.service.ts:232 — "anything sent" is checked, not "anything
    // changed", so a no-op PATCH still writes an audit row. Drop `.failing`
    // once fixed.
    it('a PATCH that changes nothing writes no audit row', async () => {
      const current = (await get(`${BASE}/${shop.id}`).expect(200)).body;
      const before = (await auditOf(shop.id)).length;

      await patch(`${BASE}/${shop.id}`, { name: current.name }).expect(200);

      expect(await auditOf(shop.id)).toHaveLength(before);
    });

    it('an empty PATCH changes nothing and writes no audit row', async () => {
      const current = (await get(`${BASE}/${shop.id}`).expect(200)).body;
      const before = (await auditOf(shop.id)).length;

      const res = await patch(`${BASE}/${shop.id}`, {}).expect(200);

      expect(res.body).toEqual(current);
      expect(await auditOf(shop.id)).toHaveLength(before);
    });

    it.each([
      ['short name', { name: 'x' }],
      ['null name', { name: null }],
      ['null phone', { phone: null }],
      ['bad phone', { phone: 'abc' }],
      ['bad email', { email: 'nope' }],
      ['bad logoUrl', { logoUrl: 'not a url' }],
    ])('400 for %s', async (_label, body) => {
      await patch(`${BASE}/${shop.id}`, body).expect(400);
    });

    it('unknown id → 404 on every :id endpoint', async () => {
      const id = randomUUID();

      for (const res of await Promise.all([
        get(`${BASE}/${id}`),
        patch(`${BASE}/${id}`, { name: 'Nobody' }),
        post(`${BASE}/${id}/suspend`),
        post(`${BASE}/${id}/activate`),
      ])) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
          statusCode: 404,
          message: 'Shop not found',
        });
      }
    });

    it('a malformed id → 400 on every :id endpoint', async () => {
      for (const res of await Promise.all([
        get(`${BASE}/not-a-uuid`),
        patch(`${BASE}/not-a-uuid`, { name: 'Nobody' }),
        post(`${BASE}/123/suspend`),
        post(`${BASE}/123/activate`),
      ])) {
        expect(res.status).toBe(400);
      }
    });
  });

  /* ---------------------------------------------------------------- */
  describe('suspend / activate', () => {
    let shop: TenantDetail;
    let ownerPhone: string;
    let ownerPassword: string;
    let managerPhone: string;
    let owner: Session;
    let manager: Session;
    let otherOwner: Session;
    let otherShop: string;

    const statusAudits = async (id: string) =>
      (await auditOf(id)).filter(
        (r) =>
          r.action === 'update' &&
          (r.after as Record<string, unknown>)?.status !== undefined &&
          Object.keys(r.after as object).length === 1,
      );

    beforeAll(async () => {
      const body = shopBody();
      const created = await createOk(body);
      shop = created.tenant;
      ownerPhone = body.owner.phone;
      ownerPassword = created.temporaryPassword;
      managerPhone = (await fx.user('manager', shop.id)).phone;
      owner = await session(ownerPhone, ownerPassword);
      manager = await session(managerPhone);

      otherShop = await fx.tenant();
      otherOwner = await session((await fx.user('owner', otherShop)).phone);
    });

    it('suspend → status suspended, every refresh token of the shop revoked', async () => {
      const res = await post(`${BASE}/${shop.id}/suspend`).expect(200);

      expect(res.body).toMatchObject({ id: shop.id, status: 'suspended' });
      const live = await fx.db
        .select({ id: refreshTokens.id })
        .from(refreshTokens)
        .innerJoin(users, eq(users.id, refreshTokens.userId))
        .where(
          and(
            eq(users.tenantId, shop.id),
            sql`${refreshTokens.revokedAt} is null`,
          ),
        );
      expect(live).toEqual([]);
      const revoked = await fx.db
        .select({ id: refreshTokens.id })
        .from(refreshTokens)
        .innerJoin(users, eq(users.id, refreshTokens.userId))
        .where(
          and(eq(users.tenantId, shop.id), isNotNull(refreshTokens.revokedAt)),
        );
      expect(revoked.length).toBeGreaterThanOrEqual(2);
    });

    it("the shop's users can no longer refresh", async () => {
      for (const s of [owner, manager]) {
        await http().post('/auth/refresh').set('Cookie', s.cookie).expect(401);
      }
    });

    it('an access token issued before the suspension gets 403 right away', async () => {
      for (const s of [owner, manager]) {
        const res = await get('/auth/me', s.accessToken).expect(403);
        expect(res.body.code).toBe('TENANT_SUSPENDED');
      }
    });

    it('logging in again → 403 TENANT_SUSPENDED', async () => {
      const res = await login(ownerPhone, ownerPassword);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        statusCode: 403,
        message: 'Shop suspended, contact support',
        code: 'TENANT_SUSPENDED',
      });
      expect((await login(managerPhone)).status).toBe(403);
    });

    it('other shops are not affected', async () => {
      await get('/auth/me', otherOwner.accessToken).expect(200);
      const res = await http()
        .post('/auth/refresh')
        .set('Cookie', otherOwner.cookie)
        .expect(200);
      otherOwner = {
        accessToken: res.body.accessToken,
        cookie: refreshCookie(res),
      };
      const [other] = await fx.db
        .select({ status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, otherShop));
      expect(other.status).toBe('active');
    });

    it('suspending again is 200 with no change and no second audit row', async () => {
      const res = await post(`${BASE}/${shop.id}/suspend`).expect(200);

      expect(res.body.status).toBe('suspended');
      const rows = await statusAudits(shop.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entity: 'tenants',
        userId: adminId,
        before: { status: 'trial' },
        after: { status: 'suspended' },
      });
    });

    it('activate → status active, users can log in again (once audited)', async () => {
      const res = await post(`${BASE}/${shop.id}/activate`).expect(200);
      await post(`${BASE}/${shop.id}/activate`).expect(200);

      expect(res.body).toMatchObject({ id: shop.id, status: 'active' });
      const fresh = await session(ownerPhone, ownerPassword);
      await get('/auth/me', fresh.accessToken).expect(200);
      expect((await login(managerPhone)).status).toBe(200);

      const rows = await statusAudits(shop.id);
      expect(rows.map((r) => [r.before, r.after])).toEqual([
        [{ status: 'trial' }, { status: 'suspended' }],
        [{ status: 'suspended' }, { status: 'active' }],
      ]);
    });

    it('a trial shop can be activated', async () => {
      const { tenant } = await createOk();

      const res = await post(`${BASE}/${tenant.id}/activate`).expect(200);

      expect(res.body.status).toBe('active');
    });
  });

  /* ---------------------------------------------------------------- */
  describe('only super_admin', () => {
    let target: string;
    const tokens: Record<string, string> = {};

    beforeAll(async () => {
      target = (await createOk()).tenant.id;
      const shop = await fx.tenant();
      for (const role of ['owner', 'manager', 'operator'] as const) {
        tokens[role] = (
          await session((await fx.user(role, shop)).phone)
        ).accessToken;
      }
    });

    const endpoints = () =>
      [
        ['GET', BASE],
        ['POST', BASE],
        ['GET', `${BASE}/${target}`],
        ['PATCH', `${BASE}/${target}`],
        ['POST', `${BASE}/${target}/suspend`],
        ['POST', `${BASE}/${target}/activate`],
      ] as const;

    const call = (method: string, url: string, token: string | null) => {
      const body = method === 'GET' ? undefined : shopBody();
      const req =
        method === 'GET'
          ? get(url, token)
          : method === 'PATCH'
            ? patch(url, { name: 'Hijacked' }, token)
            : post(url, body, token);
      return req;
    };

    it.each(['owner', 'manager', 'operator'])(
      '%s gets 403 on every endpoint and changes nothing',
      async (role) => {
        const before = await countOf(tenants);

        for (const [method, url] of endpoints()) {
          const res = await call(method, url, tokens[role]);
          expect([method, url, res.status]).toEqual([method, url, 403]);
        }

        expect(await countOf(tenants)).toBe(before);
        const detail = await get(`${BASE}/${target}`).expect(200);
        expect(detail.body.status).toBe('trial');
        expect(detail.body.name).not.toBe('Hijacked');
      },
    );

    it('no token → 401 on every endpoint', async () => {
      for (const [method, url] of endpoints()) {
        const res = await call(method, url, null);
        expect([method, url, res.status]).toEqual([method, url, 401]);
      }
    });
  });

  /* ---------------------------------------------------------------- */
  describe('tenant_settings Row-Level Security', () => {
    let shopA: string;
    let shopB: string;

    async function asShop<R>(
      tenantId: string,
      fn: (c: PoolClient) => Promise<R>,
    ): Promise<R> {
      const client = await fx.pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role app_tenant');
        await client.query("select set_config('app.tenant_id', $1, true)", [
          tenantId,
        ]);
        return await fn(client);
      } finally {
        await client.query('rollback');
        client.release();
      }
    }

    beforeAll(async () => {
      shopA = (await createOk()).tenant.id;
      shopB = (await createOk()).tenant.id;
    });

    it('has RLS enabled and the tenant_isolation policy for app_tenant', async () => {
      const { rows } = await fx.pool.query<{
        rls: boolean;
        roles: string[];
        cmd: string;
        qual: string;
        with_check: string;
      }>(
        `select c.relrowsecurity as rls, p.roles::text[] as roles, p.cmd,
                p.qual, p.with_check
           from pg_class c
           join pg_policies p on p.tablename = c.relname
          where c.oid = 'public.tenant_settings'::regclass
            and p.policyname = 'tenant_isolation'`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ rls: true, cmd: 'ALL' });
      expect(rows[0].roles).toContain('app_tenant');
      expect(rows[0].qual).toContain("current_setting('app.tenant_id'");
      expect(rows[0].with_check).toContain("current_setting('app.tenant_id'");
    });

    it("as shop A: only A's settings row is visible", async () => {
      const [all, byB] = await asShop(shopA, async (c) => [
        (
          await c.query<{ tenant_id: string }>(
            'select tenant_id from tenant_settings',
          )
        ).rows,
        (
          await c.query('select 1 from tenant_settings where tenant_id = $1', [
            shopB,
          ])
        ).rowCount,
      ]);

      expect(all).toEqual([{ tenant_id: shopA }]);
      expect(byB).toBe(0);
    });

    it("as shop A: shop B's settings can't be changed", async () => {
      const [updated, deleted] = await asShop(shopA, async (c) => [
        (
          await c.query(
            "update tenant_settings set display_name = 'hacked' where tenant_id = $1",
            [shopB],
          )
        ).rowCount,
        (
          await c.query('delete from tenant_settings where tenant_id = $1', [
            shopB,
          ])
        ).rowCount,
      ]);

      expect([updated, deleted]).toEqual([0, 0]);
      const [b] = await settingsOf(shopB);
      expect(b.displayName).not.toBe('hacked');
    });

    it('as shop A: moving its own row to shop B is rejected', async () => {
      await expect(
        asShop(shopA, (c) =>
          c.query(
            'update tenant_settings set tenant_id = $1 where tenant_id = $2',
            [shopB, shopA],
          ),
        ),
      ).rejects.toThrow(/row-level security policy/);
    });
  });
});
