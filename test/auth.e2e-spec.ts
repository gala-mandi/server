import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  authLogs,
  otpCodes,
  refreshTokens,
  users,
} from '../src/database/schema';
import {
  OTP_SENDER,
  type OtpMessage,
} from '../src/modules/auth/otp/otp-sender';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';
import { TenantProbeModule } from './support/tenant-probe.module';

interface LoginResult {
  accessToken: string;
  cookie: string;
  body: Record<string, any>;
}

function refreshCookie(res: request.Response): string {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = header?.find((c) => c.startsWith('refresh_token='));
  if (!cookie) throw new Error('no refresh cookie');
  return cookie.split(';')[0];
}

function decode(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString(),
  ) as Record<string, unknown>;
}

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;
  const sentCodes: OtpMessage[] = [];

  const http = () => request(app.getHttpServer());

  async function login(
    identifier: string,
    password = PASSWORD,
    rememberMe = false,
  ): Promise<LoginResult> {
    const res = await http()
      .post('/auth/login')
      .send({ identifier, password, rememberMe })
      .expect(200);
    return {
      accessToken: res.body.accessToken,
      cookie: refreshCookie(res),
      body: res.body,
    };
  }

  beforeAll(async () => {
    fx = new Fixtures();
    app = await createTestApp({
      imports: [TenantProbeModule],
      override: (builder) =>
        builder.overrideProvider(OTP_SENDER).useValue({
          send: (message: OtpMessage) => {
            sentCodes.push(message);
            return Promise.resolve();
          },
        }),
    });
  });

  afterAll(async () => {
    await app.close();
    await fx.cleanup();
  });

  describe('login', () => {
    it('super-admin gets a token without tenantId', async () => {
      const admin = await fx.user('super_admin', null);

      const { accessToken, body } = await login(admin.phone);

      expect(decode(accessToken)).toMatchObject({
        sub: admin.id,
        tenantId: null,
        role: 'super_admin',
      });
      expect(body.user).toMatchObject({ role: 'super_admin', tenant: null });
      expect(body.expiresIn).toBe(900);
    });

    it('shop owner gets a token with their tenantId and role', async () => {
      const tenantId = await fx.tenant();
      const owner = await fx.user('owner', tenantId);

      const { accessToken, body } = await login(owner.phone);

      expect(decode(accessToken)).toMatchObject({ tenantId, role: 'owner' });
      expect(body.user.tenant).toMatchObject({ id: tenantId });
    });

    it('accepts email as well as phone', async () => {
      const owner = await fx.user('owner', await fx.tenant());

      await login(owner.email!.toUpperCase());
    });

    it('sets an httpOnly SameSite refresh cookie', async () => {
      const owner = await fx.user('owner', await fx.tenant());

      const res = await http()
        .post('/auth/login')
        .send({ identifier: owner.phone, password: PASSWORD })
        .expect(200);
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0];

      expect(cookie).toMatch(/^refresh_token=/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).not.toMatch(/Max-Age/);
    });

    it('"keep me signed in" makes the cookie last 7 days', async () => {
      const owner = await fx.user('owner', await fx.tenant());

      const res = await http()
        .post('/auth/login')
        .send({ identifier: owner.phone, password: PASSWORD, rememberMe: true })
        .expect(200);

      expect(res.headers['set-cookie'][0]).toMatch(/Max-Age=604800/);
    });

    it('wrong password and unknown user get the same 401', async () => {
      const owner = await fx.user('owner', await fx.tenant());

      const wrong = await http()
        .post('/auth/login')
        .send({ identifier: owner.phone, password: 'nope' })
        .expect(401);
      const unknown = await http()
        .post('/auth/login')
        .send({ identifier: '03990000000', password: 'nope' })
        .expect(401);

      expect(wrong.body).toEqual({
        statusCode: 401,
        message: 'Invalid credentials',
      });
      expect(unknown.body).toEqual(wrong.body);
    });

    it('inactive user gets 403 Account disabled', async () => {
      const operator = await fx.user('operator', await fx.tenant(), {
        isActive: false,
      });

      const res = await http()
        .post('/auth/login')
        .send({ identifier: operator.phone, password: PASSWORD })
        .expect(403);

      expect(res.body).toEqual({
        statusCode: 403,
        message: 'Account disabled',
        code: 'ACCOUNT_DISABLED',
      });
    });

    it('suspended shop gets 403 Shop suspended', async () => {
      const owner = await fx.user('owner', await fx.tenant('suspended'));

      const res = await http()
        .post('/auth/login')
        .send({ identifier: owner.phone, password: PASSWORD })
        .expect(403);

      expect(res.body).toEqual({
        statusCode: 403,
        message: 'Shop suspended, contact support',
        code: 'TENANT_SUSPENDED',
      });
    });

    it('a disabled or suspended answer never comes before the password check', async () => {
      const operator = await fx.user('operator', await fx.tenant(), {
        isActive: false,
      });

      await http()
        .post('/auth/login')
        .send({ identifier: operator.phone, password: 'wrong' })
        .expect(401);
    });

    it('6th attempt within a minute gets 429 and is logged as locked', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      for (let i = 0; i < 5; i++) {
        await http()
          .post('/auth/login')
          .send({ identifier: owner.phone, password: 'wrong' })
          .expect(401);
      }

      const res = await http()
        .post('/auth/login')
        .send({ identifier: owner.phone, password: PASSWORD })
        .expect(429);

      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(res.body.message).toBe(
        'Too many attempts. Try again in a minute.',
      );
      const locked = await fx.db
        .select()
        .from(authLogs)
        .where(eq(authLogs.action, 'locked'));
      expect(locked.length).toBeGreaterThan(0);
    });

    it('the limit is per phone: another phone from the same IP still works', async () => {
      const owner = await fx.user('owner', await fx.tenant());

      await login(owner.phone);
    });

    it.each([
      [{}, ['identifier', 'password']],
      [{ identifier: '', password: '' }, ['identifier', 'password']],
      [{ identifier: 'x'.repeat(161), password: 'p' }, ['identifier']],
      [{ identifier: '0300', password: 'p'.repeat(129) }, ['password']],
      [{ identifier: 123, password: true }, ['identifier', 'password']],
    ])('bad body %j gets 400 with field errors', async (body, fields) => {
      const res = await http().post('/auth/login').send(body).expect(400);

      expect(res.body.message).toBe('Validation failed');
      expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual(
        fields,
      );
    });

    it('SQL injection in the login fields is just a wrong login', async () => {
      await fx.user('owner', await fx.tenant());

      for (const identifier of [
        "' OR '1'='1",
        "03000000002' --",
        "x'; DROP TABLE users; --",
      ]) {
        await http()
          .post('/auth/login')
          .send({ identifier, password: "' OR '1'='1" })
          .expect(401);
      }
      await http().get('/health').expect(200);
    });

    it('writes login and failed attempts to auth_logs', async () => {
      const tenantId = await fx.tenant();
      const owner = await fx.user('owner', tenantId);

      await http()
        .post('/auth/login')
        .send({ identifier: owner.phone, password: 'wrong' })
        .expect(401);
      await login(owner.phone);

      const rows = await fx.db
        .select({ action: authLogs.action, tenantId: authLogs.tenantId })
        .from(authLogs)
        .where(eq(authLogs.userId, owner.id));
      expect(rows.map((r) => r.action).sort()).toEqual(['failed', 'login']);
      expect(rows.every((r) => r.tenantId === tenantId)).toBe(true);
    });
  });

  describe('tokens and sessions', () => {
    it('refresh rotates the cookie and returns a new access token', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const first = await login(owner.phone);

      const res = await http()
        .post('/auth/refresh')
        .set('Cookie', first.cookie)
        .expect(200);

      expect(refreshCookie(res)).not.toBe(first.cookie);
      expect(res.body.user.id).toBe(owner.id);
      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
    });

    it('reusing an old refresh token ends every session of the user', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const deviceA = await login(owner.phone);
      const deviceB = await login(owner.phone);
      const rotated = await http()
        .post('/auth/refresh')
        .set('Cookie', deviceA.cookie)
        .expect(200);

      const reuse = await http()
        .post('/auth/refresh')
        .set('Cookie', deviceA.cookie)
        .expect(401);

      expect(reuse.body.code).toBe('SESSION_EXPIRED');
      await http()
        .post('/auth/refresh')
        .set('Cookie', refreshCookie(rotated))
        .expect(401);
      await http()
        .post('/auth/refresh')
        .set('Cookie', deviceB.cookie)
        .expect(401);
    });

    it('an expired refresh token is rejected', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const { cookie } = await login(owner.phone);
      await fx.db
        .update(refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(refreshTokens.userId, owner.id));

      const res = await http()
        .post('/auth/refresh')
        .set('Cookie', cookie)
        .expect(401);

      expect(res.body).toEqual({
        statusCode: 401,
        message: 'Session expired',
        code: 'SESSION_EXPIRED',
      });
    });

    it('refresh without a cookie is 401', async () => {
      await http().post('/auth/refresh').expect(401);
    });

    it('refresh is refused once the user is disabled', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const { cookie } = await login(owner.phone);
      await fx.db
        .update(users)
        .set({ isActive: false })
        .where(eq(users.id, owner.id));

      const res = await http()
        .post('/auth/refresh')
        .set('Cookie', cookie)
        .expect(403);

      expect(res.body.code).toBe('ACCOUNT_DISABLED');
    });

    it('logout revokes the token and clears the cookie', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const { cookie } = await login(owner.phone);

      const res = await http()
        .post('/auth/logout')
        .set('Cookie', cookie)
        .expect(204);

      expect(res.headers['set-cookie'][0]).toMatch(
        /refresh_token=;.*Expires=Thu, 01 Jan 1970/,
      );
      const logs = await fx.db
        .select()
        .from(authLogs)
        .where(
          and(eq(authLogs.userId, owner.id), eq(authLogs.action, 'logout')),
        );
      expect(logs).toHaveLength(1);
      await http().post('/auth/refresh').set('Cookie', cookie).expect(401);
    });

    it('logout-all ends every session', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const deviceA = await login(owner.phone);
      const deviceB = await login(owner.phone);

      await http()
        .post('/auth/logout-all')
        .set('Authorization', `Bearer ${deviceA.accessToken}`)
        .expect(204);

      await http()
        .post('/auth/refresh')
        .set('Cookie', deviceA.cookie)
        .expect(401);
      await http()
        .post('/auth/refresh')
        .set('Cookie', deviceB.cookie)
        .expect(401);
    });

    it('two devices work independently', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const deviceA = await login(owner.phone);
      const deviceB = await login(owner.phone);

      await http()
        .post('/auth/logout')
        .set('Cookie', deviceA.cookie)
        .expect(204);

      await http()
        .post('/auth/refresh')
        .set('Cookie', deviceB.cookie)
        .expect(200);
    });
  });

  describe('security', () => {
    let owner: Awaited<ReturnType<Fixtures['user']>>;
    let token: string;

    beforeAll(async () => {
      owner = await fx.user('owner', await fx.tenant());
      token = (await login(owner.phone)).accessToken;
    });

    const me = (bearer: string) =>
      http().get('/auth/me').set('Authorization', `Bearer ${bearer}`);

    it('GET /auth/me returns the user without a password hash', async () => {
      const res = await me(token).expect(200);

      expect(res.body.id).toBe(owner.id);
      expect(JSON.stringify(res.body)).not.toMatch(
        /passwordHash|password_hash|argon2/i,
      );
    });

    it('no response of the login flow contains a password hash', async () => {
      const { body } = await login(owner.phone);

      expect(JSON.stringify(body)).not.toMatch(/password_?hash|argon2/i);
    });

    it('rejects a token with a changed tenantId or role', async () => {
      const [header, , signature] = token.split('.');
      for (const change of [
        { role: 'super_admin' },
        { tenantId: '00000000-0000-0000-0000-000000000000' },
      ]) {
        const payload = Buffer.from(
          JSON.stringify({ ...decode(token), ...change }),
        ).toString('base64url');

        await me(`${header}.${payload}.${signature}`).expect(401);
      }
    });

    it('rejects a token signed with another secret', async () => {
      const forged = new JwtService({ secret: 'y'.repeat(32) }).sign({
        sub: owner.id,
        tenantId: owner.tenantId,
        role: 'owner',
        sid: 'x',
      });

      await me(forged).expect(401);
    });

    it('rejects alg: none', async () => {
      const header = Buffer.from(
        JSON.stringify({ alg: 'none', typ: 'JWT' }),
      ).toString('base64url');
      const payload = Buffer.from(JSON.stringify(decode(token))).toString(
        'base64url',
      );

      await me(`${header}.${payload}.`).expect(401);
    });

    it('rejects an expired token', async () => {
      const expired = new JwtService({
        secret: process.env.JWT_ACCESS_SECRET,
      }).sign(
        {
          sub: owner.id,
          tenantId: owner.tenantId,
          role: 'owner',
          sid: 'x',
        },
        { expiresIn: -10 },
      );

      await me(expired).expect(401);
    });

    it('rejects a missing or garbage token', async () => {
      await http().get('/auth/me').expect(401);
      await me('not-a-jwt').expect(401);
    });

    it('a disabled user loses access right away', async () => {
      const operator = await fx.user('operator', owner.tenantId);
      const { accessToken } = await login(operator.phone);
      await fx.db
        .update(users)
        .set({ isActive: false })
        .where(eq(users.id, operator.id));

      const res = await me(accessToken).expect(403);

      expect(res.body.code).toBe('ACCOUNT_DISABLED');
    });
  });

  describe('multi-tenant isolation and roles', () => {
    let shopA: string;
    let shopB: string;
    let ownerA: LoginResult;
    let userB: Awaited<ReturnType<Fixtures['user']>>;

    beforeAll(async () => {
      shopA = await fx.tenant();
      shopB = await fx.tenant();
      ownerA = await login((await fx.user('owner', shopA)).phone);
      userB = await fx.user('manager', shopB);
    });

    it('shop A reads its own record', async () => {
      const managerA = await fx.user('manager', shopA);

      await http()
        .get(`/test-probe/users/${managerA.id}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .expect(200);
    });

    it("shop A gets 404 for shop B's record id", async () => {
      await http()
        .get(`/test-probe/users/${userB.id}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .expect(404);
    });

    it("shop A cannot change shop B's record", async () => {
      await http()
        .post(`/test-probe/users/${userB.id}/rename`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'hacked' })
        .expect(404);

      const [row] = await fx.db
        .select()
        .from(users)
        .where(eq(users.id, userB.id));
      expect(row.name).toBe('Test manager');
    });

    it('tenant_id in the body is ignored', async () => {
      const res = await http()
        .post('/test-probe/echo-tenant')
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ tenant_id: shopB, tenantId: shopB })
        .expect(201);

      expect(res.body).toEqual({ tenantId: shopA });
    });

    it('super-admin without a chosen shop gets 403 on shop endpoints', async () => {
      const admin = await login((await fx.user('super_admin', null)).phone);

      await http()
        .post('/test-probe/echo-tenant')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(403);
    });

    it('operator gets 403 on an owner-only endpoint; owner gets 200', async () => {
      const operator = await login((await fx.user('operator', shopA)).phone);

      await http()
        .get('/test-probe/owner-only')
        .set('Authorization', `Bearer ${operator.accessToken}`)
        .expect(403);
      await http()
        .get('/test-probe/owner-only')
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .expect(200);
    });
  });

  describe('password', () => {
    it('change-password with the wrong current password is 400', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const { accessToken } = await login(owner.phone);

      const res = await http()
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: 'wrong', newPassword: 'New-password-1' })
        .expect(400);

      expect(res.body.errors).toEqual([
        { field: 'currentPassword', message: 'Current password is incorrect' },
      ]);
    });

    it('change-password keeps this session and ends the others', async () => {
      const owner = await fx.user('owner', await fx.tenant(), {
        mustChangePassword: true,
      });
      const current = await login(owner.phone);
      const other = await login(owner.phone);

      const res = await http()
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${current.accessToken}`)
        .send({ currentPassword: PASSWORD, newPassword: 'New-password-1' })
        .expect(200);

      expect(res.body).toEqual({ revokedSessions: 1 });
      await http()
        .post('/auth/refresh')
        .set('Cookie', other.cookie)
        .expect(401);
      const refreshed = await http()
        .post('/auth/refresh')
        .set('Cookie', current.cookie)
        .expect(200);
      expect(refreshed.body.user.mustChangePassword).toBe(false);
      await login(owner.phone, 'New-password-1');
    });

    it('rejects a new password that is too short', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const { accessToken } = await login(owner.phone);

      const res = await http()
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: PASSWORD, newPassword: 'short' })
        .expect(400);

      expect(res.body.errors[0].field).toBe('newPassword');
    });

    it('forgot-password answers the same for unknown phones', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      sentCodes.length = 0;

      const known = await http()
        .post('/auth/forgot-password')
        .send({ phone: owner.phone, channel: 'sms' })
        .expect(202);
      const unknown = await http()
        .post('/auth/forgot-password')
        .send({ phone: '03990000001', channel: 'sms' })
        .expect(202);

      expect(unknown.body).toEqual(known.body);
      expect(sentCodes).toHaveLength(1);
      expect(sentCodes[0]).toMatchObject({
        phone: owner.phone,
        channel: 'sms',
      });
    });

    it('reset with the code changes the password and ends every session', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      const session = await login(owner.phone);
      sentCodes.length = 0;
      await http()
        .post('/auth/forgot-password')
        .send({ phone: owner.phone })
        .expect(202);
      const { code } = sentCodes[0];

      const res = await http()
        .post('/auth/reset-password')
        .send({ phone: owner.phone, code, newPassword: 'Reset-password-1' })
        .expect(200);

      expect(res.body).toEqual({ revokedSessions: 1 });
      await http()
        .post('/auth/refresh')
        .set('Cookie', session.cookie)
        .expect(401);
      await login(owner.phone, 'Reset-password-1');
      const logs = await fx.db
        .select()
        .from(authLogs)
        .where(
          and(eq(authLogs.userId, owner.id), eq(authLogs.action, 'reset')),
        );
      expect(logs).toHaveLength(1);
    });

    it('a code works only once', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      sentCodes.length = 0;
      await http().post('/auth/forgot-password').send({ phone: owner.phone });
      const { code } = sentCodes[0];
      await http()
        .post('/auth/reset-password')
        .send({ phone: owner.phone, code, newPassword: 'Reset-password-1' })
        .expect(200);

      const res = await http()
        .post('/auth/reset-password')
        .send({ phone: owner.phone, code, newPassword: 'Reset-password-2' })
        .expect(400);

      expect(res.body.code).toBe('INVALID_OTP');
    });

    it('an expired code is rejected', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      sentCodes.length = 0;
      await http().post('/auth/forgot-password').send({ phone: owner.phone });
      await fx.db
        .update(otpCodes)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(otpCodes.userId, owner.id));

      await http()
        .post('/auth/reset-password')
        .send({
          phone: owner.phone,
          code: sentCodes[0].code,
          newPassword: 'Reset-password-1',
        })
        .expect(400);
    });

    it('a wrong code is rejected and counted', async () => {
      const owner = await fx.user('owner', await fx.tenant());
      sentCodes.length = 0;
      await http().post('/auth/forgot-password').send({ phone: owner.phone });
      const wrong = sentCodes[0].code === '000000' ? '111111' : '000000';

      await http()
        .post('/auth/reset-password')
        .send({
          phone: owner.phone,
          code: wrong,
          newPassword: 'Reset-password-1',
        })
        .expect(400);

      const [otp] = await fx.db
        .select()
        .from(otpCodes)
        .where(eq(otpCodes.userId, owner.id));
      expect(otp.attempts).toBe(1);
    });
  });
});
