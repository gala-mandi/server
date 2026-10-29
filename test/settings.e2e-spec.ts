import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import { and, asc, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { auditLogs, tenantSettings, tenants } from '../src/database/schema';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const LOGO_MAX_BYTES = 1024 * 1024;
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0];
const UPLOADS_DIR = process.env.UPLOADS_DIR as string;

/** A buffer of `size` bytes that starts with `header`. */
function image(header: number[], size = 256): Buffer {
  const buffer = Buffer.alloc(size, 0x11);
  Buffer.from(header).copy(buffer);
  return buffer;
}

/** `03991234567` → `+92 399 1234567` (how people type it). */
const intl = (phone: string) => `+92 ${phone.slice(1, 4)} ${phone.slice(4)}`;

type Route = { method: 'get' | 'patch' | 'post'; path: string };
const ROUTES: Route[] = [
  { method: 'get', path: '/settings' },
  { method: 'patch', path: '/settings' },
  { method: 'post', path: '/settings/logo' },
];

describe('Shop settings /settings (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;

  let shopA: string;
  let shopB: string;
  const tokens = {} as Record<
    'ownerA' | 'ownerB' | 'manager' | 'operator' | 'superAdmin',
    string
  >;

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string | null) =>
    token ? req.set('Authorization', `Bearer ${token}`) : req;
  const get = (token: string | null) => as(http().get('/settings'), token);
  const patch = (token: string | null, body: object) =>
    as(http().patch('/settings'), token).send(body);
  const upload = (
    token: string | null,
    body: Buffer,
    filename = 'logo.png',
    contentType = 'image/png',
  ) =>
    as(http().post('/settings/logo'), token).attach('file', body, {
      filename,
      contentType,
    });

  /** Login is limited per IP; every test comes from one IP. */
  function resetAuthThrottle(): void {
    const storage = app.get<ThrottlerStorageService>(getStorageToken(), {
      strict: false,
    });
    storage.storage.clear();
    (
      Reflect.get(storage, 'hitExpirations') as Map<string, unknown> | undefined
    )?.clear();
  }

  async function login(identifier: string): Promise<string> {
    resetAuthThrottle();
    const res = await http()
      .post('/auth/login')
      .send({ identifier, password: PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  /** A fresh shop (no settings row yet) with a signed-in owner. */
  async function newShop() {
    const tenantId = await fx.tenant();
    shopIds.push(tenantId);
    const owner = await fx.user('owner', tenantId);
    return { tenantId, token: await login(owner.phone) };
  }

  /** Shops whose logo folders are removed after the suite. */
  const shopIds: string[] = [];
  const removeUploads = (id: string) =>
    rm(join(UPLOADS_DIR, 'tenants', id), { recursive: true, force: true });

  async function tenantRow(id: string) {
    const [row] = await fx.db.select().from(tenants).where(eq(tenants.id, id));
    return row;
  }

  async function settingsRows(id: string) {
    return fx.db
      .select()
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, id));
  }

  const auditOf = (tenantId: string) =>
    fx.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          inArray(auditLogs.entity, ['tenants', 'tenant_settings']),
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
    shopB = await fx.tenant();
    shopIds.push(shopA, shopB);
    const ownerA = await fx.user('owner', shopA);
    const ownerB = await fx.user('owner', shopB);
    const manager = await fx.user('manager', shopA);
    const operator = await fx.user('operator', shopA);
    const superAdmin = await fx.user('super_admin', null);

    tokens.ownerA = await login(ownerA.phone);
    tokens.ownerB = await login(ownerB.phone);
    tokens.manager = await login(manager.phone);
    tokens.operator = await login(operator.phone);
    tokens.superAdmin = await login(superAdmin.phone);
  });

  afterAll(async () => {
    await app.close();
    // Logo files this suite wrote; the rows go with fx.cleanup().
    await Promise.all(shopIds.map(removeUploads));
    await fx.cleanup();
  });

  /* ---------------------------------------------------------------- */
  describe('GET /settings', () => {
    it('a new shop gets the defaults, and its missing settings row is created', async () => {
      const { tenantId, token } = await newShop();
      expect(await settingsRows(tenantId)).toHaveLength(0);
      const shop = await tenantRow(tenantId);

      const res = await get(token).expect(200);

      expect(res.body).toEqual({
        name: shop.name,
        phone: shop.phone,
        email: null,
        address: null,
        city: null,
        logoUrl: null,
        displayName: shop.name,
        parchiFooter: null,
        defaultCommissionPct: '0.00',
        marketFeePct: '0.00',
        labourPerBag: '0.00',
        defaultUnit: 'kg',
        maundKg: '40.000',
        billPrefix: null,
        financialYearStart: null,
        language: 'en',
        updatedAt: expect.stringMatching(ISO),
      });
      const rows = await settingsRows(tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0].displayName).toBe(shop.name);
    });

    it('reading twice does not create a second row', async () => {
      const { tenantId, token } = await newShop();

      const [first, second] = await Promise.all([get(token), get(token)]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(await settingsRows(tenantId)).toHaveLength(1);
    });

    it('does not leak internal columns', async () => {
      const res = await get(tokens.ownerA).expect(200);

      for (const key of ['id', 'tenantId', 'slug', 'status', 'ownerName']) {
        expect(res.body).not.toHaveProperty(key);
      }
    });
  });

  /* ---------------------------------------------------------------- */
  describe('PATCH /settings', () => {
    it('owner changes commission % → saved and returned as "2.50"', async () => {
      const { tenantId, token } = await newShop();

      const res = await patch(token, { defaultCommissionPct: '2.5' }).expect(
        200,
      );

      expect(res.body.defaultCommissionPct).toBe('2.50');
      expect((await get(token).expect(200)).body.defaultCommissionPct).toBe(
        '2.50',
      );
      expect((await settingsRows(tenantId))[0].defaultCommissionPct).toBe(
        '2.50',
      );
    });

    it('maund set to 40 kg works (maundKg "40.000")', async () => {
      const { token } = await newShop();

      await patch(token, { maundKg: '37.324' }).expect(200);
      const res = await patch(token, { maundKg: '40' }).expect(200);

      expect(res.body.maundKg).toBe('40.000');
      expect((await get(token)).body.maundKg).toBe('40.000');
    });

    it('updates shop profile and settings fields together and audits each table', async () => {
      const { tenantId, token } = await newShop();
      const before = await get(token).expect(200);
      const shopBefore = await tenantRow(tenantId);
      const phone = fx.phone();

      const res = await patch(token, {
        name: 'Al-Madina Traders',
        phone: intl(phone),
        email: 'shop@example.com',
        city: 'Okara',
        displayName: 'Al-Madina',
        labourPerBag: '15',
        defaultUnit: 'maund',
        language: 'ur',
        billPrefix: 'AM-',
        financialYearStart: '2026-07-01',
      }).expect(200);

      expect(res.body).toMatchObject({
        name: 'Al-Madina Traders',
        phone, // normalised
        email: 'shop@example.com',
        city: 'Okara',
        address: null,
        displayName: 'Al-Madina',
        labourPerBag: '15.00',
        defaultUnit: 'maund',
        language: 'ur',
        billPrefix: 'AM-',
        financialYearStart: '2026-07-01',
        defaultCommissionPct: '0.00',
      });
      expect(Date.parse(res.body.updatedAt as string)).toBeGreaterThanOrEqual(
        Date.parse(before.body.updatedAt as string),
      );
      expect((await get(token)).body).toEqual(res.body);
      expect(await tenantRow(tenantId)).toMatchObject({
        name: 'Al-Madina Traders',
        phone,
        email: 'shop@example.com',
        city: 'Okara',
        // Not part of settings: untouched.
        slug: shopBefore.slug,
        status: shopBefore.status,
        ownerName: shopBefore.ownerName,
      });

      const audit = await auditOf(tenantId);
      expect(audit).toHaveLength(2);
      const [shopLog, settingsLog] = audit;
      expect(shopLog).toMatchObject({
        entity: 'tenants',
        entityId: tenantId,
        action: 'update',
        before: {
          name: shopBefore.name,
          phone: shopBefore.phone,
          email: null,
          city: null,
        },
        after: {
          name: 'Al-Madina Traders',
          phone,
          email: 'shop@example.com',
          city: 'Okara',
        },
      });
      expect(shopLog.userId).toEqual(expect.any(String));
      expect(Object.keys(shopLog.after as object).sort()).toEqual(
        ['city', 'email', 'name', 'phone'].sort(),
      );

      expect(settingsLog).toMatchObject({
        entity: 'tenant_settings',
        entityId: tenantId,
        action: 'update',
        before: {
          displayName: shopBefore.name,
          labourPerBag: '0.00',
          defaultUnit: 'kg',
          language: 'en',
          billPrefix: null,
          financialYearStart: null,
        },
        after: {
          displayName: 'Al-Madina',
          labourPerBag: '15.00',
          defaultUnit: 'maund',
          language: 'ur',
          billPrefix: 'AM-',
          financialYearStart: '2026-07-01',
        },
      });
      expect(Object.keys(settingsLog.after as object).sort()).toEqual(
        [
          'billPrefix',
          'defaultUnit',
          'displayName',
          'financialYearStart',
          'labourPerBag',
          'language',
        ].sort(),
      );
    });

    it('only settings fields → only a tenant_settings audit row', async () => {
      const { tenantId, token } = await newShop();

      await patch(token, { marketFeePct: '1' }).expect(200);

      const audit = await auditOf(tenantId);
      expect(audit.map((a) => a.entity)).toEqual(['tenant_settings']);
      expect(audit[0].before).toEqual({ marketFeePct: '0.00' });
      expect(audit[0].after).toEqual({ marketFeePct: '1.00' });
    });

    it('nothing changed → no audit row', async () => {
      const { tenantId, token } = await newShop();
      const current = (await get(token).expect(200)).body;

      const res = await patch(token, {
        name: current.name,
        phone: current.phone,
        email: null,
        defaultCommissionPct: '0',
        maundKg: '40',
        defaultUnit: 'kg',
        billPrefix: '',
      }).expect(200);

      expect(res.body).toMatchObject({
        name: current.name,
        defaultCommissionPct: '0.00',
        maundKg: '40.000',
        billPrefix: null,
      });
      expect(await auditOf(tenantId)).toEqual([]);
    });

    it('an empty body changes nothing', async () => {
      const { tenantId, token } = await newShop();
      const current = (await get(token).expect(200)).body;

      const res = await patch(token, {}).expect(200);

      expect(res.body).toEqual(current);
      expect(await auditOf(tenantId)).toEqual([]);
    });

    it('empty optional text clears the value (stored as null)', async () => {
      const { tenantId, token } = await newShop();
      await patch(token, {
        address: 'Main Bazaar',
        parchiFooter: 'Thanks',
      }).expect(200);

      const res = await patch(token, {
        address: '',
        parchiFooter: '  ',
      }).expect(200);

      expect(res.body).toMatchObject({ address: null, parchiFooter: null });
      expect((await tenantRow(tenantId)).address).toBeNull();
      expect((await settingsRows(tenantId))[0].parchiFooter).toBeNull();
    });

    it('invalid values → 400 with field errors, and nothing is saved', async () => {
      const { tenantId, token } = await newShop();

      const res = await patch(token, {
        name: 'Should Not Save',
        defaultCommissionPct: '100.5',
        marketFeePct: '-1',
        labourPerBag: '1.234',
        maundKg: '0',
        billPrefix: 'A B',
        defaultUnit: 'ton',
      }).expect(400);

      expect(res.body).toMatchObject({
        statusCode: 400,
        message: 'Validation failed',
      });
      const fields = (res.body.errors as { field: string }[]).map(
        (e) => e.field,
      );
      expect(fields.sort()).toEqual(
        [
          'billPrefix',
          'defaultCommissionPct',
          'defaultUnit',
          'labourPerBag',
          'marketFeePct',
          'maundKg',
        ].sort(),
      );
      expect(res.body.errors).toContainEqual({
        field: 'maundKg',
        message: 'Kg per maund must be more than 0',
      });
      expect((await tenantRow(tenantId)).name).not.toBe('Should Not Save');
      expect(await auditOf(tenantId)).toEqual([]);
    });

    it('a 100 % commission is allowed, 100.5 is not', async () => {
      const { token } = await newShop();

      expect(
        (await patch(token, { defaultCommissionPct: '100' }).expect(200)).body
          .defaultCommissionPct,
      ).toBe('100.00');
      await patch(token, { defaultCommissionPct: '100.5' }).expect(400);
    });

    it('a decimal sent as a JSON number is refused (strings only)', async () => {
      const { token } = await newShop();

      const res = await patch(token, { defaultCommissionPct: 2.5 }).expect(400);

      expect(res.body.errors[0].field).toBe('defaultCommissionPct');
    });

    it('logoUrl can only be removed here, not set', async () => {
      const { token } = await newShop();

      const res = await patch(token, {
        logoUrl: 'https://evil.example/logo.png',
      }).expect(400);

      expect(res.body.errors[0].field).toBe('logoUrl');
    });

    it("tenant_id / tenantId in the body are ignored: the change goes to the token's shop", async () => {
      const before = await get(tokens.ownerB).expect(200);
      const shopBRow = await tenantRow(shopB);

      const res = await patch(tokens.ownerA, {
        name: 'Moved Shop',
        defaultCommissionPct: '4',
        tenant_id: shopB,
        tenantId: shopB,
      }).expect(200);

      expect(res.body).toMatchObject({
        name: 'Moved Shop',
        defaultCommissionPct: '4.00',
      });
      expect((await tenantRow(shopA)).name).toBe('Moved Shop');
      expect(await tenantRow(shopB)).toEqual(shopBRow);
      expect((await get(tokens.ownerB).expect(200)).body).toEqual(before.body);
    });

    it('a status or slug in the body cannot change the shop', async () => {
      const shop = await tenantRow(shopA);

      await patch(tokens.ownerA, { status: 'cancelled' }).expect(400);
      await patch(tokens.ownerA, { slug: 'taken-over' }).expect(400);

      expect(await tenantRow(shopA)).toMatchObject({
        status: shop.status,
        slug: shop.slug,
      });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('tenant isolation', () => {
    it("owner A's PATCH never changes shop B; GET shows each shop its own values", async () => {
      await patch(tokens.ownerB, {
        name: 'Shop B Grain',
        defaultCommissionPct: '1.25',
        city: 'Sahiwal',
      }).expect(200);
      const shopBRow = await tenantRow(shopB);
      const shopBSettings = await settingsRows(shopB);
      const shopBAudit = await auditOf(shopB);

      const resA = await patch(tokens.ownerA, {
        name: 'Shop A Grain',
        defaultCommissionPct: '3',
        city: 'Okara',
      }).expect(200);

      expect(resA.body).toMatchObject({
        name: 'Shop A Grain',
        defaultCommissionPct: '3.00',
        city: 'Okara',
      });
      expect(await tenantRow(shopB)).toEqual(shopBRow);
      expect(await settingsRows(shopB)).toEqual(shopBSettings);
      expect(await auditOf(shopB)).toEqual(shopBAudit);

      const resB = await get(tokens.ownerB).expect(200);
      expect(resB.body).toMatchObject({
        name: 'Shop B Grain',
        defaultCommissionPct: '1.25',
        city: 'Sahiwal',
      });
      expect((await get(tokens.ownerA).expect(200)).body).toMatchObject({
        name: 'Shop A Grain',
        defaultCommissionPct: '3.00',
      });
    });

    it("owner A's logo goes to shop A only", async () => {
      const logoB = (await get(tokens.ownerB).expect(200)).body.logoUrl;

      const res = await upload(tokens.ownerA, image(PNG_HEADER)).expect(200);

      expect(res.body.logoUrl).toContain(`/uploads/tenants/${shopA}/`);
      expect((await get(tokens.ownerB).expect(200)).body.logoUrl).toBe(logoB);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('who may use it', () => {
    it.each(ROUTES.map((r) => [r.method.toUpperCase(), r.path, r] as const))(
      'manager → 403 on %s %s',
      async (_m, _p, route) => {
        const res = await as(
          http()[route.method](route.path),
          tokens.manager,
        ).expect(403);
        expect(res.body.statusCode).toBe(403);
      },
    );

    it.each(ROUTES.map((r) => [r.method.toUpperCase(), r.path, r] as const))(
      'operator → 403 on %s %s',
      async (_m, _p, route) => {
        await as(http()[route.method](route.path), tokens.operator).expect(403);
      },
    );

    it.each(ROUTES.map((r) => [r.method.toUpperCase(), r.path, r] as const))(
      'super-admin (no shop) → 403 on %s %s',
      async (_m, _p, route) => {
        await as(http()[route.method](route.path), tokens.superAdmin).expect(
          403,
        );
      },
    );

    it.each(ROUTES.map((r) => [r.method.toUpperCase(), r.path, r] as const))(
      'no token → 401 on %s %s',
      async (_m, _p, route) => {
        await http()[route.method](route.path).expect(401);
      },
    );

    it('a manager cannot change settings, even with a valid body', async () => {
      const before = await settingsRows(shopA);

      await patch(tokens.manager, { defaultCommissionPct: '9' }).expect(403);
      await upload(tokens.manager, image(PNG_HEADER)).expect(403);

      expect(await settingsRows(shopA)).toEqual(before);
    });

    it('the owner of a suspended shop → 403', async () => {
      const { tenantId, token } = await newShop();
      await get(token).expect(200);
      await fx.db
        .update(tenants)
        .set({ status: 'suspended' })
        .where(eq(tenants.id, tenantId));

      await get(token).expect(403);
      await patch(token, { city: 'Okara' }).expect(403);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('POST /settings/logo', () => {
    /** `http://host/uploads/x` → `/uploads/x`. */
    const pathOf = (url: string) => new URL(url).pathname;

    it.each([
      ['PNG', PNG_HEADER, 'logo.png', 'image/png', 'png'],
      ['JPG', JPEG_HEADER, 'logo.jpg', 'image/jpeg', 'jpg'],
    ])(
      'a small %s → logoUrl, and the file is served at /uploads',
      async (_kind, header, filename, contentType, ext) => {
        const { tenantId, token } = await newShop();
        const body = image(header, 2048);

        const res = await upload(token, body, filename, contentType).expect(
          200,
        );

        expect(res.body.logoUrl).toMatch(
          new RegExp(
            `^https?://[^/]+/uploads/tenants/${tenantId}/logo-[0-9a-f-]{36}\\.${ext}$`,
          ),
        );
        expect((await tenantRow(tenantId)).logoUrl).toBe(res.body.logoUrl);
        expect((await get(token)).body.logoUrl).toBe(res.body.logoUrl);

        const path = pathOf(res.body.logoUrl as string);
        expect(
          readFileSync(join(UPLOADS_DIR, path.replace(/^\/uploads\//, ''))),
        ).toEqual(body);

        const file = await http().get(path).expect(200);
        expect(file.headers['cross-origin-resource-policy']).toBe(
          'cross-origin',
        );
        expect(file.headers['content-type']).toBe(contentType);
        expect(Buffer.from(file.body as Buffer)).toEqual(body);

        const audit = await auditOf(tenantId);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          entity: 'tenants',
          action: 'update',
          before: { logoUrl: null },
          after: { logoUrl: res.body.logoUrl },
        });
      },
    );

    it('the file type comes from the bytes, not the name (JPG named .png)', async () => {
      const { token } = await newShop();

      const res = await upload(
        token,
        image(JPEG_HEADER),
        'logo.png',
        'image/png',
      ).expect(200);

      expect(res.body.logoUrl).toMatch(/\.jpg$/);
    });

    it('a new logo replaces the old one; PATCH logoUrl: null removes it', async () => {
      const { tenantId, token } = await newShop();
      const first = await upload(token, image(PNG_HEADER)).expect(200);
      const second = await upload(token, image(JPEG_HEADER), 'b.jpg').expect(
        200,
      );

      expect(second.body.logoUrl).not.toBe(first.body.logoUrl);

      const res = await patch(token, { logoUrl: null }).expect(200);
      expect(res.body.logoUrl).toBeNull();
      expect((await tenantRow(tenantId)).logoUrl).toBeNull();
    });

    it('exactly 1 MB is accepted', async () => {
      const { token } = await newShop();

      await upload(token, image(PNG_HEADER, LOGO_MAX_BYTES)).expect(200);
    });

    it('a PDF named logo.png → 400 INVALID_FILE_TYPE, logo unchanged', async () => {
      const { tenantId, token } = await newShop();
      const pdf = Buffer.from(
        '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n',
      );

      const res = await upload(token, pdf, 'logo.png', 'image/png').expect(400);

      expect(res.body).toEqual({
        statusCode: 400,
        message: 'The logo must be a PNG or JPG image',
        code: 'INVALID_FILE_TYPE',
        errors: [
          { field: 'file', message: 'The logo must be a PNG or JPG image' },
        ],
      });
      expect((await tenantRow(tenantId)).logoUrl).toBeNull();
      expect(existsSync(join(UPLOADS_DIR, 'tenants', tenantId))).toBe(false);
    });

    it('a PDF sent as application/pdf → 400 INVALID_FILE_TYPE', async () => {
      const { token } = await newShop();

      const res = await upload(
        token,
        Buffer.from('%PDF-1.4\n%%EOF\n'),
        'logo.pdf',
        'application/pdf',
      ).expect(400);

      expect(res.body.code).toBe('INVALID_FILE_TYPE');
    });

    it('1 MB + 1 byte → 413 FILE_TOO_LARGE with a clear message', async () => {
      const { tenantId, token } = await newShop();

      const res = await upload(
        token,
        image(PNG_HEADER, LOGO_MAX_BYTES + 1),
      ).expect(413);

      expect(res.body).toEqual({
        statusCode: 413,
        message: 'The logo must be 1 MB or smaller',
        code: 'FILE_TOO_LARGE',
        errors: [
          { field: 'file', message: 'The logo must be 1 MB or smaller' },
        ],
      });
      expect((await tenantRow(tenantId)).logoUrl).toBeNull();
    });

    it('a 5 MB file → 413 FILE_TOO_LARGE', async () => {
      const { token } = await newShop();

      const res = await upload(
        token,
        image(PNG_HEADER, 5 * LOGO_MAX_BYTES),
      ).expect(413);

      expect(res.body.code).toBe('FILE_TOO_LARGE');
      expect(res.body.message).toBe('The logo must be 1 MB or smaller');
    });

    it('no file → 400 FILE_REQUIRED', async () => {
      const { token } = await newShop();

      const res = await as(http().post('/settings/logo'), token).expect(400);

      expect(res.body).toEqual({
        statusCode: 400,
        message: 'Choose a logo image',
        code: 'FILE_REQUIRED',
        errors: [{ field: 'file', message: 'Choose a logo image' }],
      });
    });

    it('a multipart form without the file field → 400 FILE_REQUIRED', async () => {
      const { token } = await newShop();

      const res = await as(http().post('/settings/logo'), token)
        .field('note', 'no file here')
        .expect(400);

      expect(res.body.code).toBe('FILE_REQUIRED');
    });

    it('/uploads serves nothing outside the uploads folder', async () => {
      await http().get('/uploads/../package.json').expect(404);
      await http()
        .get('/uploads/%2e%2e/package.json')
        .expect((res) => {
          expect([403, 404]).toContain(res.status);
        });
    });
  });
});
