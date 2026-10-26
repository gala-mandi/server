import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import type { Role } from '../src/common/auth/auth-user';
import {
  ALL_ROLES,
  type Permission,
  ROLE_PERMISSIONS,
  roleHas,
} from '../src/common/auth/permissions';
import { users } from '../src/database/schema';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';
import {
  PROBE_ROUTES,
  type ProbeRoute,
  RbacProbeModule,
} from './support/rbac-probe.module';

interface Session {
  accessToken: string;
  cookie: string;
  body: Record<string, any>;
}

const NO_ACCESS = 'You do not have access to this action';

function probe(permission: Permission): ProbeRoute {
  const route = PROBE_ROUTES.find((r) => r.permission === permission);
  if (!route) throw new Error(`no probe route for ${permission}`);
  return route;
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

/** Status the matrix says a role gets on a probe route. */
function expectedStatus(role: Role, route: ProbeRoute): number {
  if (!roleHas(role, route.permission)) return 403;
  // A super-admin token has no shop: shop routes stay closed.
  if (route.shop && role === 'super_admin') return 403;
  return route.ok;
}

describe('RBAC (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;
  let tenantId: string;
  const ids = {} as Record<Role, string>;
  const sessions = {} as Record<Role, Session>;

  const http = () => request(app.getHttpServer());

  function call(route: Pick<ProbeRoute, 'method' | 'path'>, token?: string) {
    const req = http()[route.method](route.path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  async function login(identifier: string): Promise<Session> {
    const res = await http()
      .post('/auth/login')
      .send({ identifier, password: PASSWORD })
      .expect(200);
    return {
      accessToken: res.body.accessToken,
      cookie: refreshCookie(res),
      body: res.body,
    };
  }

  const changeRole = (token: string, userId: string, role: string) =>
    http()
      .patch(`/rbac-probe/staff/${userId}/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role });

  beforeAll(async () => {
    fx = new Fixtures();
    app = await createTestApp({
      imports: [RbacProbeModule],
      override: (builder) =>
        builder
          .overrideProvider(OTP_SENDER)
          .useValue({ send: () => Promise.resolve() }),
    });

    tenantId = await fx.tenant();
    for (const role of ALL_ROLES) {
      const user = await fx.user(
        role,
        role === 'super_admin' ? null : tenantId,
      );
      ids[role] = user.id;
      sessions[role] = await login(user.phone);
    }
  });

  afterAll(async () => {
    await app.close();
    await fx.cleanup();
  });

  describe.each(ALL_ROLES)('permission matrix: %s', (role) => {
    it.each(PROBE_ROUTES.map((r) => [r.method.toUpperCase(), r.path, r]))(
      '%s %s',
      async (_method, _path, route) => {
        const status = expectedStatus(role, route);

        const res = await call(route, sessions[role].accessToken).expect(
          status,
        );

        if (status === 403) expect(res.body.statusCode).toBe(403);
        else expect(res.body).toEqual({ ok: true });
      },
    );
  });

  it('the matrix is not trivially closed: every role can reach something', () => {
    for (const role of ALL_ROLES) {
      expect(PROBE_ROUTES.some((r) => expectedStatus(role, r) !== 403)).toBe(
        true,
      );
    }
  });

  describe('shop-only routes', () => {
    it.each<Role>(['owner', 'manager', 'operator'])(
      '%s with a shop gets in',
      async (role) => {
        await call(
          { method: 'get', path: '/rbac-probe/shop' },
          sessions[role].accessToken,
        ).expect(200);
      },
    );

    it('super-admin without a tenant is 403 even when the role is allowed', async () => {
      const res = await call(
        { method: 'get', path: '/rbac-probe/shop' },
        sessions.super_admin.accessToken,
      ).expect(403);

      expect(res.body.message).toBe('No shop selected');
    });
  });

  describe('scenarios', () => {
    it('operator tries to delete a purchase → 403', async () => {
      const res = await call(
        probe('purchase.delete'),
        sessions.operator.accessToken,
      ).expect(403);

      expect(res.body).toEqual({ statusCode: 403, message: NO_ACCESS });
    });

    it('manager opens staff management → 403', async () => {
      const res = await call(
        { method: 'get', path: '/rbac-probe/staff' },
        sessions.manager.accessToken,
      ).expect(403);

      expect(res.body.message).toBe(NO_ACCESS);
    });

    it('super-admin calls a shop-only endpoint without a tenant → 403', async () => {
      await call(
        { method: 'get', path: '/rbac-probe/reports' },
        sessions.super_admin.accessToken,
      ).expect(403);
      await call(
        { method: 'get', path: '/rbac-probe/shop' },
        sessions.super_admin.accessToken,
      ).expect(403);
    });

    it('hidden button bypassed with a direct API call → still 403', async () => {
      // The UI hides "edit" for operators; calling the API directly fails too.
      expect(sessions.operator.body.user.permissions).not.toContain(
        'purchase.edit',
      );

      await http()
        .patch(probe('purchase.edit').path)
        .set('Authorization', `Bearer ${sessions.operator.accessToken}`)
        .send({ total: '1.00' })
        .expect(403);
    });

    it('no token → 401 on every probe route', async () => {
      const routes = [
        ...PROBE_ROUTES,
        { method: 'get', path: '/rbac-probe/shop' },
        { method: 'patch', path: `/rbac-probe/staff/${ids.manager}/role` },
        { method: 'get', path: '/rbac-probe/undecorated' },
      ] as const;
      for (const route of routes) {
        const res = await call(route).expect(401);
        expect(res.body.statusCode).toBe(401);
      }
    });

    it('a route without any access metadata still needs a token', async () => {
      await call({ method: 'get', path: '/rbac-probe/undecorated' }).expect(
        401,
      );
      await call(
        { method: 'get', path: '/rbac-probe/undecorated' },
        sessions.operator.accessToken,
      ).expect(200);
    });

    it('role tampered in the token (operator → owner, same signature) → 401', async () => {
      const token = sessions.operator.accessToken;
      const [header, , signature] = token.split('.');
      const payload = Buffer.from(
        JSON.stringify({ ...decode(token), role: 'owner' }),
      ).toString('base64url');
      const forged = `${header}.${payload}.${signature}`;

      await call(probe('purchase.delete'), forged).expect(401);
      await call({ method: 'get', path: '/rbac-probe/staff' }, forged).expect(
        401,
      );
    });
  });

  describe('permissions in the session', () => {
    it.each(ALL_ROLES)(
      'GET /auth/me and login return the %s permissions',
      async (role) => {
        const res = await http()
          .get('/auth/me')
          .set('Authorization', `Bearer ${sessions[role].accessToken}`)
          .expect(200);

        expect(res.body.permissions).toEqual([...ROLE_PERMISSIONS[role]]);
        expect(sessions[role].body.user.permissions).toEqual([
          ...ROLE_PERMISSIONS[role],
        ]);
      },
    );
  });

  describe('changing a role', () => {
    it('owner makes a manager an operator: applies on the next refresh', async () => {
      const shop = await fx.tenant();
      const owner = await fx.user('owner', shop);
      const manager = await fx.user('manager', shop);
      const ownerSession = await login(owner.phone);
      const managerSession = await login(manager.phone);

      const res = await changeRole(
        ownerSession.accessToken,
        manager.id,
        'operator',
      ).expect(200);
      expect(res.body).toEqual({ id: manager.id, role: 'operator' });

      // The old access token still carries "manager" until it is refreshed.
      await call(
        { method: 'get', path: '/rbac-probe/reports' },
        managerSession.accessToken,
      ).expect(200);
      const meBefore = await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${managerSession.accessToken}`)
        .expect(200);
      expect(meBefore.body.role).toBe('manager');
      expect(meBefore.body.permissions).toEqual([...ROLE_PERMISSIONS.manager]);

      const refreshed = await http()
        .post('/auth/refresh')
        .set('Cookie', managerSession.cookie)
        .expect(200);
      const token = refreshed.body.accessToken as string;

      expect(decode(token).role).toBe('operator');
      expect(refreshed.body.user.permissions).toEqual([
        ...ROLE_PERMISSIONS.operator,
      ]);
      await call({ method: 'get', path: '/rbac-probe/reports' }, token).expect(
        403,
      );
      await call(
        { method: 'post', path: '/rbac-probe/purchases' },
        token,
      ).expect(201);
      const me = await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(me.body.role).toBe('operator');
      expect(me.body.permissions).toEqual([...ROLE_PERMISSIONS.operator]);
    });

    it('the last owner cannot downgrade themselves → 400', async () => {
      const shop = await fx.tenant();
      const owner = await fx.user('owner', shop);
      const { accessToken } = await login(owner.phone);

      const res = await changeRole(accessToken, owner.id, 'manager').expect(
        400,
      );

      expect(res.body.message).toBe('A shop needs at least one owner');
      expect(res.body.errors[0].field).toBe('role');
      const [row] = await fx.db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, owner.id));
      expect(row.role).toBe('owner');
    });

    it('an owner can step down when another owner is left', async () => {
      const shop = await fx.tenant();
      const owner = await fx.user('owner', shop);
      await fx.user('owner', shop);
      const { accessToken } = await login(owner.phone);

      const res = await changeRole(accessToken, owner.id, 'manager').expect(
        200,
      );

      expect(res.body).toEqual({ id: owner.id, role: 'manager' });
    });

    it('a disabled second owner does not count: the last active owner stays', async () => {
      const shop = await fx.tenant();
      const owner = await fx.user('owner', shop);
      await fx.user('owner', shop, { isActive: false });
      const { accessToken } = await login(owner.phone);

      await changeRole(accessToken, owner.id, 'manager').expect(400);
    });

    it('a user of another shop → 404 and is not changed', async () => {
      const otherShop = await fx.tenant();
      const stranger = await fx.user('manager', otherShop);

      await changeRole(
        sessions.owner.accessToken,
        stranger.id,
        'operator',
      ).expect(404);

      const [row] = await fx.db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, stranger.id));
      expect(row.role).toBe('manager');
    });

    it('a super-admin account is outside every shop → 404', async () => {
      await changeRole(
        sessions.owner.accessToken,
        ids.super_admin,
        'owner',
      ).expect(404);
    });

    it('a shop user cannot be made a super-admin → 400', async () => {
      await changeRole(
        sessions.owner.accessToken,
        ids.operator,
        'super_admin',
      ).expect(400);
    });

    it.each<Role>(['manager', 'operator'])(
      '%s cannot change roles → 403',
      async (role) => {
        await changeRole(
          sessions[role].accessToken,
          ids.operator,
          'manager',
        ).expect(403);
      },
    );
  });

  describe('public routes need no token', () => {
    it('GET /health', async () => {
      await http().get('/health').expect(200);
    });

    it('POST /auth/login answers on credentials, not on a missing token', async () => {
      const res = await http()
        .post('/auth/login')
        .send({ identifier: '03980000000', password: 'Wrong-pass-1' })
        .expect(401);

      expect(res.body.message).toBe('Invalid credentials');
    });

    it('POST /auth/refresh without a cookie is SESSION_EXPIRED, not a guard 401', async () => {
      const res = await http().post('/auth/refresh').expect(401);

      expect(res.body.code).toBe('SESSION_EXPIRED');
    });

    it('POST /auth/forgot-password', async () => {
      await http()
        .post('/auth/forgot-password')
        .send({ phone: '03980000001' })
        .expect(202);
    });

    it('POST /auth/reset-password validates the body instead of asking for a token', async () => {
      await http().post('/auth/reset-password').send({}).expect(400);
    });

    it('POST /auth/logout', async () => {
      await http().post('/auth/logout').expect(204);
    });
  });
});
