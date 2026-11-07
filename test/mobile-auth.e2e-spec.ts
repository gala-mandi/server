import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { refreshTokens, tenants, users } from '../src/database/schema';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';
import { TenantProbeModule } from './support/tenant-probe.module';

interface MobileSession {
  accessToken: string;
  refreshToken: string;
  body: Record<string, any>;
}

function decode(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString(),
  ) as Record<string, unknown>;
}

/** The mobile app (server#46): refresh token in the JSON body, never a cookie. */
describe('Auth — mobile app mode (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;

  const http = () => request(app.getHttpServer());
  const MOBILE = { 'X-Client': 'mobile' };

  async function mobileLogin(
    identifier: string,
    rememberMe = true,
  ): Promise<MobileSession> {
    const res = await http()
      .post('/auth/login')
      .set(MOBILE)
      .send({ identifier, password: PASSWORD, rememberMe })
      .expect(200);
    return {
      accessToken: res.body.accessToken,
      refreshToken: res.body.refreshToken,
      body: res.body,
    };
  }

  const mobileRefresh = (refreshToken?: string) =>
    http()
      .post('/auth/refresh')
      .set(MOBILE)
      .send(refreshToken === undefined ? {} : { refreshToken });

  beforeAll(async () => {
    fx = new Fixtures();
    app = await createTestApp({ imports: [TenantProbeModule] });
  });

  afterAll(async () => {
    await app.close();
    await fx.cleanup();
  });

  it('Swagger documents the X-Client header and the mobile session', async () => {
    const res = await http().get('/docs-json').expect(200);
    const doc = res.body as {
      paths: Record<
        string,
        Record<string, { parameters?: { name: string }[] }>
      >;
      components: { schemas: Record<string, { properties?: object }> };
    };

    for (const path of ['/auth/login', '/auth/refresh', '/auth/logout']) {
      expect(doc.paths[path].post.parameters?.map((p) => p.name)).toContain(
        'X-Client',
      );
    }
    expect(doc.components.schemas.MobileSessionDto.properties).toHaveProperty(
      'refreshToken',
    );
    expect(doc.components.schemas.SessionDto.properties).not.toHaveProperty(
      'refreshToken',
    );
  });

  describe('login', () => {
    it('returns the refresh token in the body and sets no cookie', async () => {
      const tenantId = await fx.tenant();
      const owner = await fx.user('owner', tenantId);

      const res = await http()
        .post('/auth/login')
        .set(MOBILE)
        .send({ identifier: owner.phone, password: PASSWORD })
        .expect(200);

      expect(res.headers['set-cookie']).toBeUndefined();
      expect(typeof res.body.refreshToken).toBe('string');
      expect(res.body.refreshToken.length).toBeGreaterThan(40);
      expect(res.body.expiresIn).toBe(900);
      expect(res.body.user).toMatchObject({
        id: owner.id,
        role: 'owner',
        tenant: { id: tenantId, status: 'active' },
      });
      expect(decode(res.body.accessToken as string)).toMatchObject({
        sub: owner.id,
        tenantId,
        role: 'owner',
      });
    });

    it('the header value is case-insensitive', async () => {
      const owner = await fx.user('owner', await fx.tenant());

      const res = await http()
        .post('/auth/login')
        .set('x-client', 'Mobile')
        .send({ identifier: owner.phone, password: PASSWORD })
        .expect(200);

      expect(res.body.refreshToken).toBeDefined();
    });

    it('web login is unchanged: cookie only, no token in the body', async () => {
      const owner = await fx.user('owner', await fx.tenant());

      const res = await http()
        .post('/auth/login')
        .send({ identifier: owner.phone, password: PASSWORD })
        .expect(200);

      expect(res.body).not.toHaveProperty('refreshToken');
      expect(res.headers['set-cookie'][0]).toMatch(/^refresh_token=/);
    });

    it('wrong password gets the same 401 as the web', async () => {
      const owner = await fx.user('owner', await fx.tenant());

      const res = await http()
        .post('/auth/login')
        .set(MOBILE)
        .send({ identifier: owner.phone, password: 'wrong' })
        .expect(401);

      expect(res.body).toEqual({
        statusCode: 401,
        message: 'Invalid credentials',
      });
    });

    it('disabled account gets 403 ACCOUNT_DISABLED', async () => {
      const operator = await fx.user('operator', await fx.tenant(), {
        isActive: false,
      });

      const res = await http()
        .post('/auth/login')
        .set(MOBILE)
        .send({ identifier: operator.phone, password: PASSWORD })
        .expect(403);

      expect(res.body.code).toBe('ACCOUNT_DISABLED');
      expect(res.body).not.toHaveProperty('refreshToken');
    });

    it('suspended shop gets 403 TENANT_SUSPENDED', async () => {
      const owner = await fx.user('owner', await fx.tenant('suspended'));

      const res = await http()
        .post('/auth/login')
        .set(MOBILE)
        .send({ identifier: owner.phone, password: PASSWORD })
        .expect(403);

      expect(res.body).toEqual({
        statusCode: 403,
        message: 'Shop suspended, contact support',
        code: 'TENANT_SUSPENDED',
      });
    });
  });

  describe('refresh', () => {
    it('rotates the token sent in the body', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const first = await mobileLogin(owner.phone);

      const res = await mobileRefresh(first.refreshToken).expect(200);

      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.body.refreshToken).toBeDefined();
      expect(res.body.refreshToken).not.toBe(first.refreshToken);
      expect(res.body.user.id).toBe(owner.id);
      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
    });

    it('keeps the session going across many rotations (app reopened)', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      let { refreshToken } = await mobileLogin(owner.phone);

      for (let i = 0; i < 3; i++) {
        const res = await mobileRefresh(refreshToken).expect(200);
        refreshToken = res.body.refreshToken as string;
      }

      const rows = await fx.db
        .select({ familyId: refreshTokens.familyId })
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, owner.id));
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
    });

    it('reusing an old token ends every session, web and mobile', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const phone = await mobileLogin(owner.phone);
      const other = await mobileLogin(owner.phone);
      const web = await http()
        .post('/auth/login')
        .send({ identifier: owner.phone, password: PASSWORD })
        .expect(200);
      const webCookie = (
        web.headers['set-cookie'] as unknown as string[]
      )[0].split(';')[0];
      const rotated = await mobileRefresh(phone.refreshToken).expect(200);

      const reuse = await mobileRefresh(phone.refreshToken).expect(401);

      expect(reuse.body).toEqual({
        statusCode: 401,
        message: 'Session expired',
        code: 'SESSION_EXPIRED',
      });
      await mobileRefresh(rotated.body.refreshToken as string).expect(401);
      await mobileRefresh(other.refreshToken).expect(401);
      await http().post('/auth/refresh').set('Cookie', webCookie).expect(401);
    });

    it('the same token sent twice at once is accepted at most once', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const { refreshToken } = await mobileLogin(owner.phone);

      const results = await Promise.all([
        mobileRefresh(refreshToken),
        mobileRefresh(refreshToken),
      ]);

      // Never two live successors from one token.
      expect(results.filter((r) => r.status === 200).length).toBeLessThan(2);
      expect(results.map((r) => r.status)).toContain(401);
    });

    it('an expired token is rejected', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const { refreshToken } = await mobileLogin(owner.phone);
      await fx.db
        .update(refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(refreshTokens.userId, owner.id));

      const res = await mobileRefresh(refreshToken).expect(401);

      expect(res.body.code).toBe('SESSION_EXPIRED');
    });

    it.each([
      ['no token', undefined],
      ['an empty token', ''],
      ['an unknown token', 'not-a-real-token.p'],
    ])('%s is 401 SESSION_EXPIRED', async (_, token) => {
      const res = await mobileRefresh(token).expect(401);

      expect(res.body.code).toBe('SESSION_EXPIRED');
    });

    it('no body at all is 401 SESSION_EXPIRED', async () => {
      const res = await http().post('/auth/refresh').set(MOBILE).expect(401);

      expect(res.body.code).toBe('SESSION_EXPIRED');
    });

    it('a malformed body is 400 with field errors', async () => {
      const res = await http()
        .post('/auth/refresh')
        .set(MOBILE)
        .send({ refreshToken: 12345 })
        .expect(400);

      expect(res.body.message).toBe('Validation failed');
      expect(res.body.errors[0].field).toBe('refreshToken');
    });

    it('is refused once the user is disabled', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const { refreshToken } = await mobileLogin(owner.phone);
      await fx.db
        .update(users)
        .set({ isActive: false })
        .where(eq(users.id, owner.id));

      const res = await mobileRefresh(refreshToken).expect(403);

      expect(res.body.code).toBe('ACCOUNT_DISABLED');
    });

    it('is refused once the shop is suspended', async () => {
      const tenantId = await fx.tenant();
      const owner = await fx.user('owner', tenantId);
      const { refreshToken } = await mobileLogin(owner.phone);
      await fx.db
        .update(tenants)
        .set({ status: 'suspended' })
        .where(eq(tenants.id, tenantId));

      const res = await mobileRefresh(refreshToken).expect(403);

      expect(res.body.code).toBe('TENANT_SUSPENDED');
    });

    it('the web cannot use a body token: without the header it reads only the cookie', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const { refreshToken } = await mobileLogin(owner.phone);

      await http().post('/auth/refresh').send({ refreshToken }).expect(401);
      // The token was not consumed by that attempt.
      await mobileRefresh(refreshToken).expect(200);
    });

    it('mobile mode ignores the web cookie', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const web = await http()
        .post('/auth/login')
        .send({ identifier: owner.phone, password: PASSWORD })
        .expect(200);
      const webCookie = (
        web.headers['set-cookie'] as unknown as string[]
      )[0].split(';')[0];

      await http()
        .post('/auth/refresh')
        .set(MOBILE)
        .set('Cookie', webCookie)
        .expect(401);
    });
  });

  describe('logout', () => {
    it('revokes the body token and sets no cookie', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const { refreshToken } = await mobileLogin(owner.phone);

      const res = await http()
        .post('/auth/logout')
        .set(MOBILE)
        .send({ refreshToken })
        .expect(204);

      expect(res.headers['set-cookie']).toBeUndefined();
      await mobileRefresh(refreshToken).expect(401);
    });

    it('ends only this phone; another device keeps working', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const phoneA = await mobileLogin(owner.phone);
      const phoneB = await mobileLogin(owner.phone);

      await http()
        .post('/auth/logout')
        .set(MOBILE)
        .send({ refreshToken: phoneA.refreshToken })
        .expect(204);

      await mobileRefresh(phoneB.refreshToken).expect(200);
    });

    it('without a token is a harmless 204', async () => {
      await http().post('/auth/logout').set(MOBILE).expect(204);
    });

    it('logout-all from the app ends every session', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const phoneA = await mobileLogin(owner.phone);
      const phoneB = await mobileLogin(owner.phone);

      const res = await http()
        .post('/auth/logout-all')
        .set(MOBILE)
        .set('Authorization', `Bearer ${phoneA.accessToken}`)
        .expect(204);

      expect(res.headers['set-cookie']).toBeUndefined();
      await mobileRefresh(phoneA.refreshToken).expect(401);
      await mobileRefresh(phoneB.refreshToken).expect(401);
    });
  });

  describe('two-shop isolation (same rules as the web)', () => {
    let shopA: string;
    let shopB: string;
    let ownerA: MobileSession;
    let managerA: Awaited<ReturnType<Fixtures['user']>>;
    let userB: Awaited<ReturnType<Fixtures['user']>>;

    beforeAll(async () => {
      shopA = await fx.tenant();
      shopB = await fx.tenant();
      ownerA = await mobileLogin((await fx.user('owner', shopA)).phone);
      managerA = await fx.user('manager', shopA);
      userB = await fx.user('manager', shopB);
    });

    it("the app's token carries only its own shop", () => {
      expect(decode(ownerA.accessToken)).toMatchObject({ tenantId: shopA });
      expect(ownerA.body.user.tenantId).toBe(shopA);
    });

    it('shop A reads its own record', async () => {
      await http()
        .get(`/test-probe/users/${managerA.id}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .expect(200);
    });

    it("shop A gets 404 for shop B's record, read and write", async () => {
      await http()
        .get(`/test-probe/users/${userB.id}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .expect(404);
      await http()
        .post(`/test-probe/users/${userB.id}/rename`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'hacked' })
        .expect(404);
    });

    it('a refreshed token still belongs to shop A; tenant_id in the body is ignored', async () => {
      const refreshed = await mobileRefresh(ownerA.refreshToken).expect(200);
      ownerA.refreshToken = refreshed.body.refreshToken as string;
      const token = refreshed.body.accessToken as string;

      expect(decode(token)).toMatchObject({ tenantId: shopA });
      const echo = await http()
        .post('/test-probe/echo-tenant')
        .set('Authorization', `Bearer ${token}`)
        .send({ tenant_id: shopB, tenantId: shopB })
        .expect(201);
      expect(echo.body).toEqual({ tenantId: shopA });
      await http()
        .get(`/test-probe/users/${userB.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it("shop B's refresh token can't be used to reach shop A", async () => {
      const ownerB = await mobileLogin((await fx.user('owner', shopB)).phone);
      const refreshed = await mobileRefresh(ownerB.refreshToken).expect(200);

      expect(decode(refreshed.body.accessToken as string)).toMatchObject({
        tenantId: shopB,
      });
      await http()
        .get(`/test-probe/users/${managerA.id}`)
        .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
        .expect(404);
    });
  });
});
