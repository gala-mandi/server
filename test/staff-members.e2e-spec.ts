import { INestApplication } from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import { and, eq, isNull } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ROLE_PERMISSIONS } from '../src/common/auth/permissions';
import { auditLogs, refreshTokens, users } from '../src/database/schema';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import {
  INVITE_SENDER,
  type InviteMessage,
} from '../src/modules/staff/invite-sender';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';

type UserRow = typeof users.$inferSelect;

interface Session {
  accessToken: string;
  cookie: string;
  body: Record<string, any>;
}

const LAST_OWNER = 'A shop needs at least one owner';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

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

describe('Staff members (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;
  const sent: InviteMessage[] = [];

  let shopA: string;
  let shopB: string;
  let ownerA: UserRow;
  let operatorB: UserRow;
  const tokens = {} as Record<
    'ownerA' | 'ownerB' | 'manager' | 'operator' | 'superAdmin',
    string
  >;

  const http = () => request(app.getHttpServer());

  /** Login and accept are limited per IP; every test comes from one IP. */
  function resetAuthThrottle(): void {
    const storage = app.get<ThrottlerStorageService>(getStorageToken(), {
      strict: false,
    });
    storage.storage.clear();
    (
      Reflect.get(storage, 'hitExpirations') as Map<string, unknown> | undefined
    )?.clear();
  }

  async function login(
    identifier: string,
    password = PASSWORD,
  ): Promise<Session> {
    resetAuthThrottle();
    const res = await http()
      .post('/auth/login')
      .send({ identifier, password })
      .expect(200);
    return {
      accessToken: res.body.accessToken,
      cookie: refreshCookie(res),
      body: res.body,
    };
  }

  const tryLogin = (identifier: string, password = PASSWORD) => {
    resetAuthThrottle();
    return http().post('/auth/login').send({ identifier, password });
  };

  const refresh = (cookie: string) =>
    http().post('/auth/refresh').set('Cookie', cookie);

  const me = (token: string) =>
    http().get('/auth/me').set('Authorization', `Bearer ${token}`);

  const list = (token: string) =>
    http().get('/staff').set('Authorization', `Bearer ${token}`);

  const changeRole = (token: string, id: string, role: unknown) =>
    http()
      .patch(`/staff/${id}/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role });

  const deactivate = (token: string, id: string) =>
    http()
      .post(`/staff/${id}/deactivate`)
      .set('Authorization', `Bearer ${token}`);

  const activate = (token: string, id: string) =>
    http()
      .post(`/staff/${id}/activate`)
      .set('Authorization', `Bearer ${token}`);

  async function userRow(id: string): Promise<UserRow> {
    const [row] = await fx.db.select().from(users).where(eq(users.id, id));
    return row;
  }

  function userAudit(id: string) {
    return fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity, 'users'), eq(auditLogs.entityId, id)));
  }

  async function activeOwners(tenantId: string): Promise<UserRow[]> {
    return fx.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.tenantId, tenantId),
          eq(users.role, 'owner'),
          eq(users.isActive, true),
          isNull(users.deletedAt),
        ),
      );
  }

  async function liveRefreshTokens(userId: string) {
    return fx.db
      .select()
      .from(refreshTokens)
      .where(
        and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)),
      );
  }

  /** A fresh shop with a signed-in owner, for tests that change owners. */
  async function newShop(ownerName = 'Test owner') {
    const tenantId = await fx.tenant();
    const owner = await fx.user('owner', tenantId, { name: ownerName });
    const session = await login(owner.phone);
    return { tenantId, owner, session, token: session.accessToken };
  }

  beforeAll(async () => {
    fx = new Fixtures();
    app = await createTestApp({
      override: (builder) =>
        builder
          .overrideProvider(INVITE_SENDER)
          .useValue({
            send: (message: InviteMessage) => {
              sent.push(message);
              return Promise.resolve();
            },
          })
          .overrideProvider(OTP_SENDER)
          .useValue({ send: () => Promise.resolve() }),
    });

    shopA = await fx.tenant();
    shopB = await fx.tenant();
    ownerA = await fx.user('owner', shopA);
    const ownerB = await fx.user('owner', shopB);
    operatorB = await fx.user('operator', shopB);
    const manager = await fx.user('manager', shopA);
    const operator = await fx.user('operator', shopA);
    const superAdmin = await fx.user('super_admin', null);

    tokens.ownerA = (await login(ownerA.phone)).accessToken;
    tokens.ownerB = (await login(ownerB.phone)).accessToken;
    tokens.manager = (await login(manager.phone)).accessToken;
    tokens.operator = (await login(operator.phone)).accessToken;
    tokens.superAdmin = (await login(superAdmin.phone)).accessToken;
  });

  beforeEach(() => resetAuthThrottle());

  afterAll(async () => {
    await app.close();
    await fx.cleanup();
  });

  describe('GET /staff', () => {
    let shop: Awaited<ReturnType<typeof newShop>>;
    const people = {} as Record<
      'bilal' | 'ahmed' | 'chaudhry' | 'yasir' | 'deleted',
      UserRow
    >;

    beforeAll(async () => {
      shop = await newShop('Zed Owner');
      people.bilal = await fx.user('owner', shop.tenantId, {
        name: 'Bilal Owner',
        isActive: false,
      });
      people.yasir = await fx.user('operator', shop.tenantId, {
        name: 'Yasir Operator',
        isActive: false,
      });
      people.ahmed = await fx.user('manager', shop.tenantId, {
        name: 'Ahmed Manager',
      });
      people.chaudhry = await fx.user('operator', shop.tenantId, {
        name: 'Chaudhry Operator',
        email: null,
        mustChangePassword: true,
      });
      people.deleted = await fx.user('manager', shop.tenantId, {
        name: 'Aaron Deleted',
        deletedAt: new Date(),
      });
    });

    it('owners first, then by name; inactive included, soft-deleted not', async () => {
      const res = await list(shop.token).expect(200);

      expect(Object.keys(res.body as object)).toEqual(['data']);
      expect((res.body.data as { name: string }[]).map((m) => m.name)).toEqual([
        'Bilal Owner',
        'Zed Owner',
        'Ahmed Manager',
        'Chaudhry Operator',
        'Yasir Operator',
      ]);
      const ids = (res.body.data as { id: string }[]).map((m) => m.id);
      expect(ids).not.toContain(people.deleted.id);
    });

    it('returns the StaffMember shape and never the password hash', async () => {
      const res = await list(shop.token).expect(200);
      const chaudhry = (res.body.data as Record<string, unknown>[]).find(
        (m) => m.id === people.chaudhry.id,
      );

      expect(chaudhry).toEqual({
        id: people.chaudhry.id,
        name: 'Chaudhry Operator',
        phone: people.chaudhry.phone,
        email: null,
        role: 'operator',
        isActive: true,
        lastLoginAt: null,
        mustChangePassword: true,
        createdAt: people.chaudhry.createdAt.toISOString(),
        isYou: false,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
      const yasir = (res.body.data as Record<string, unknown>[]).find(
        (m) => m.id === people.yasir.id,
      );
      expect(yasir).toMatchObject({ isActive: false, role: 'operator' });
    });

    it('isYou is true only for the caller', async () => {
      const res = await list(shop.token).expect(200);
      const data = res.body.data as { id: string; isYou: boolean }[];

      expect(data.filter((m) => m.isYou).map((m) => m.id)).toEqual([
        shop.owner.id,
      ]);
    });

    it('lastLoginAt is null before the first login and set after it', async () => {
      const find = async () =>
        (
          (await list(shop.token).expect(200)).body.data as {
            id: string;
            lastLoginAt: string | null;
          }[]
        ).find((m) => m.id === people.ahmed.id)!;

      expect((await find()).lastLoginAt).toBeNull();

      const before = Date.now();
      await login(people.ahmed.phone);
      const after = await find();

      expect(after.lastLoginAt).toMatch(ISO);
      expect(Date.parse(after.lastLoginAt!)).toBeGreaterThan(before - 60_000);
      expect(Date.parse(after.lastLoginAt!)).toBeLessThanOrEqual(
        Date.now() + 60_000,
      );
    });

    it("shows only the caller's shop", async () => {
      const resA = await list(tokens.ownerA).expect(200);
      const resB = await list(tokens.ownerB).expect(200);
      const idsA = (resA.body.data as { id: string }[]).map((m) => m.id);
      const idsB = (resB.body.data as { id: string }[]).map((m) => m.id);

      expect(idsA).toContain(ownerA.id);
      expect(idsA).not.toContain(operatorB.id);
      expect(idsB).toContain(operatorB.id);
      expect(idsB).not.toContain(ownerA.id);
      expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);

      const rows = await fx.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, shopA), isNull(users.deletedAt)));
      expect([...idsA].sort()).toEqual(rows.map((r) => r.id).sort());
    });
  });

  describe('PATCH /staff/:id/role', () => {
    it('manager → operator returns the member with the new role', async () => {
      const { tenantId, token } = await newShop();
      const manager = await fx.user('manager', tenantId, { name: 'Mo' });

      const res = await changeRole(token, manager.id, 'operator').expect(200);

      expect(res.body).toEqual({
        id: manager.id,
        name: 'Mo',
        phone: manager.phone,
        email: manager.email,
        role: 'operator',
        isActive: true,
        lastLoginAt: null,
        mustChangePassword: false,
        createdAt: manager.createdAt.toISOString(),
        isYou: false,
      });
      expect((await userRow(manager.id)).role).toBe('operator');
    });

    it('old access token keeps manager rights until /auth/refresh', async () => {
      const { tenantId, token } = await newShop();
      const manager = await fx.user('manager', tenantId);
      const session = await login(manager.phone);

      await changeRole(token, manager.id, 'operator').expect(200);

      const before = await me(session.accessToken).expect(200);
      expect(before.body.role).toBe('manager');
      expect(before.body.permissions).toEqual([...ROLE_PERMISSIONS.manager]);
      expect(decode(session.accessToken).role).toBe('manager');

      const refreshed = await refresh(session.cookie).expect(200);
      const next = refreshed.body.accessToken as string;

      expect(decode(next).role).toBe('operator');
      expect(refreshed.body.user.permissions).toEqual([
        ...ROLE_PERMISSIONS.operator,
      ]);
      const after = await me(next).expect(200);
      expect(after.body.role).toBe('operator');
      expect(after.body.permissions).toEqual([...ROLE_PERMISSIONS.operator]);
      expect(after.body.permissions).not.toContain('report.view');
    });

    it('writes one audit row with only the role', async () => {
      const { tenantId, token, owner } = await newShop();
      const manager = await fx.user('manager', tenantId);

      await changeRole(token, manager.id, 'operator').expect(200);

      const rows = await userAudit(manager.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId,
        userId: owner.id,
        action: 'update',
        before: { role: 'manager' },
        after: { role: 'operator' },
      });
    });

    it('the same role is a no-op: 200, no audit row', async () => {
      const { tenantId, token } = await newShop();
      const operator = await fx.user('operator', tenantId);

      const res = await changeRole(token, operator.id, 'operator').expect(200);

      expect(res.body).toMatchObject({ id: operator.id, role: 'operator' });
      expect(await userAudit(operator.id)).toHaveLength(0);
      expect((await userRow(operator.id)).updatedAt).toEqual(
        operator.updatedAt,
      );
    });

    describe('a shop keeps an active owner', () => {
      it('the last active owner cannot step down → 400 field role', async () => {
        const { owner, token } = await newShop();

        const res = await changeRole(token, owner.id, 'manager').expect(400);

        expect(res.body).toEqual({
          statusCode: 400,
          message: LAST_OWNER,
          errors: [{ field: 'role', message: LAST_OWNER }],
        });
        expect((await userRow(owner.id)).role).toBe('owner');
        expect(await userAudit(owner.id)).toHaveLength(0);
      });

      it('a disabled second owner does not count', async () => {
        const { tenantId, owner, token } = await newShop();
        await fx.user('owner', tenantId, { isActive: false });

        const res = await changeRole(token, owner.id, 'operator').expect(400);

        expect(res.body.errors).toEqual([
          { field: 'role', message: LAST_OWNER },
        ]);
      });

      it('promoting a manager to owner lets the first owner step down', async () => {
        const { tenantId, owner, token } = await newShop();
        const manager = await fx.user('manager', tenantId);

        await changeRole(token, owner.id, 'manager').expect(400);
        const promoted = await changeRole(token, manager.id, 'owner').expect(
          200,
        );
        expect(promoted.body.role).toBe('owner');

        const res = await changeRole(token, owner.id, 'manager').expect(200);

        expect(res.body).toMatchObject({
          id: owner.id,
          role: 'manager',
          isYou: true,
        });
        expect((await activeOwners(tenantId)).map((o) => o.id)).toEqual([
          manager.id,
        ]);
      });

      it('race: two owners demoting each other → exactly one succeeds', async () => {
        const { tenantId, owner: first, token: firstToken } = await newShop();
        const second = await fx.user('owner', tenantId);
        const { accessToken: secondToken } = await login(second.phone);

        const results = await Promise.all([
          changeRole(firstToken, second.id, 'manager'),
          changeRole(secondToken, first.id, 'manager'),
        ]);

        expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
        const loser = results.find((r) => r.status === 400)!;
        expect(loser.body.message).toBe(LAST_OWNER);
        expect(await activeOwners(tenantId)).toHaveLength(1);
      });

      it('race: two owners each stepping down at once → one stays owner', async () => {
        const { tenantId, owner: first, token: firstToken } = await newShop();
        const second = await fx.user('owner', tenantId);
        const { accessToken: secondToken } = await login(second.phone);

        const results = await Promise.all([
          changeRole(firstToken, first.id, 'operator'),
          changeRole(secondToken, second.id, 'operator'),
        ]);

        expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
        expect(await activeOwners(tenantId)).toHaveLength(1);
      });
    });

    it("another shop's user → 404 and is not changed", async () => {
      await changeRole(tokens.ownerA, operatorB.id, 'manager').expect(404);
      await changeRole(tokens.ownerA, UNKNOWN_ID, 'manager').expect(404);

      expect((await userRow(operatorB.id)).role).toBe('operator');
      expect(await userAudit(operatorB.id)).toHaveLength(0);
    });

    it.each(['super_admin', 'x', '', null, 'OWNER'])(
      'role %p → 400 on field role',
      async (role) => {
        const { tenantId, token } = await newShop();
        const operator = await fx.user('operator', tenantId);

        const res = await changeRole(token, operator.id, role).expect(400);

        expect(res.body.errors).toEqual([
          expect.objectContaining({ field: 'role' }),
        ]);
        expect((await userRow(operator.id)).role).toBe('operator');
      },
    );

    it('no body → 400', async () => {
      await http()
        .patch(`/staff/${ownerA.id}/role`)
        .set('Authorization', `Bearer ${tokens.ownerA}`)
        .expect(400);
    });

    it('a malformed id → 400', async () => {
      await changeRole(tokens.ownerA, 'not-a-uuid', 'manager').expect(400);
    });
  });

  describe('POST /staff/:id/deactivate', () => {
    it('operator: inactive, logged out at once, cannot sign in', async () => {
      const { tenantId, token } = await newShop();
      const operator = await fx.user('operator', tenantId);
      const session = await login(operator.phone);
      // A second device too: every session must end.
      const other = await login(operator.phone);
      await me(session.accessToken).expect(200);

      const res = await deactivate(token, operator.id).expect(200);

      expect(res.body).toMatchObject({
        id: operator.id,
        role: 'operator',
        isActive: false,
        isYou: false,
      });
      expect(res.body.lastLoginAt).toMatch(ISO);
      expect((await userRow(operator.id)).isActive).toBe(false);
      expect(await liveRefreshTokens(operator.id)).toHaveLength(0);

      await refresh(session.cookie).expect(401);
      await refresh(other.cookie).expect(401);
      const access = await me(session.accessToken).expect(403);
      expect(access.body.code).toBe('ACCOUNT_DISABLED');
      const signIn = await tryLogin(operator.phone).expect(403);
      expect(signIn.body.code).toBe('ACCOUNT_DISABLED');
    });

    it('writes one audit row with only isActive', async () => {
      const { tenantId, token, owner } = await newShop();
      const operator = await fx.user('operator', tenantId);

      await deactivate(token, operator.id).expect(200);

      const rows = await userAudit(operator.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId,
        userId: owner.id,
        action: 'update',
        before: { isActive: true },
        after: { isActive: false },
      });
    });

    it('deactivating twice → 200 both times, one audit row', async () => {
      const { tenantId, token } = await newShop();
      const operator = await fx.user('operator', tenantId);

      await deactivate(token, operator.id).expect(200);
      const again = await deactivate(token, operator.id).expect(200);

      expect(again.body).toMatchObject({ id: operator.id, isActive: false });
      expect(await userAudit(operator.id)).toHaveLength(1);
    });

    it('self → 400 CANNOT_DEACTIVATE_SELF', async () => {
      const { tenantId, owner, session } = await newShop();
      // Even with another active owner left.
      await fx.user('owner', tenantId);

      const res = await deactivate(session.accessToken, owner.id).expect(400);

      expect(res.body).toMatchObject({
        statusCode: 400,
        code: 'CANNOT_DEACTIVATE_SELF',
      });
      expect((await userRow(owner.id)).isActive).toBe(true);
      await refresh(session.cookie).expect(200);
    });

    it('another owner can be deactivated while an active owner remains', async () => {
      const { tenantId, token } = await newShop();
      const second = await fx.user('owner', tenantId);
      const secondSession = await login(second.phone);

      const res = await deactivate(token, second.id).expect(200);

      expect(res.body).toMatchObject({
        id: second.id,
        role: 'owner',
        isActive: false,
      });
      expect(await activeOwners(tenantId)).toHaveLength(1);
      await refresh(secondSession.cookie).expect(401);
    });

    it('the last active owner → 400, and their sessions stay', async () => {
      // The only way a caller can reach this: owner A stepped down to
      // manager, but A's access token still says "owner" until refresh.
      const { tenantId, owner: first, token: firstToken } = await newShop();
      const second = await fx.user('owner', tenantId);
      const secondSession = await login(second.phone);
      await fx.user('owner', tenantId, { isActive: false });
      await changeRole(firstToken, first.id, 'manager').expect(200);

      const res = await deactivate(firstToken, second.id).expect(400);

      expect(res.body.message).toBe(LAST_OWNER);
      expect((await userRow(second.id)).isActive).toBe(true);
      expect(await activeOwners(tenantId)).toHaveLength(1);
      expect(await userAudit(second.id)).toHaveLength(0);
      await refresh(secondSession.cookie).expect(200);
    });

    it('race: two owners deactivating each other → exactly one succeeds', async () => {
      const { tenantId, owner: first, token: firstToken } = await newShop();
      const second = await fx.user('owner', tenantId);
      const { accessToken: secondToken } = await login(second.phone);

      const results = await Promise.all([
        deactivate(firstToken, second.id),
        deactivate(secondToken, first.id),
      ]);

      // The loser is either refused as the last owner (400) or, if the
      // winner committed before the loser's token was checked, disabled (403).
      const statuses = results.map((r) => r.status).sort();
      expect(statuses[0]).toBe(200);
      expect([400, 403]).toContain(statuses[1]);
      expect(await activeOwners(tenantId)).toHaveLength(1);
    });

    it("another shop's user → 404; their sessions stay", async () => {
      const session = await login(operatorB.phone);

      await deactivate(tokens.ownerA, operatorB.id).expect(404);
      await deactivate(tokens.ownerA, UNKNOWN_ID).expect(404);

      expect((await userRow(operatorB.id)).isActive).toBe(true);
      await refresh(session.cookie).expect(200);
    });

    it('a malformed id → 400', async () => {
      await deactivate(tokens.ownerA, 'not-a-uuid').expect(400);
    });
  });

  describe('POST /staff/:id/activate', () => {
    it('a deactivated user can sign in again', async () => {
      const { tenantId, token } = await newShop();
      const operator = await fx.user('operator', tenantId);
      await deactivate(token, operator.id).expect(200);
      await tryLogin(operator.phone).expect(403);

      const res = await activate(token, operator.id).expect(200);

      expect(res.body).toMatchObject({ id: operator.id, isActive: true });
      const session = await login(operator.phone);
      await me(session.accessToken).expect(200);
      const rows = await userAudit(operator.id);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.after)).toEqual(
        expect.arrayContaining([{ isActive: false }, { isActive: true }]),
      );
    });

    it('an active user is a no-op: 200, no audit row', async () => {
      const { tenantId, token } = await newShop();
      const operator = await fx.user('operator', tenantId);
      const session = await login(operator.phone);

      const res = await activate(token, operator.id).expect(200);

      expect(res.body).toMatchObject({ id: operator.id, isActive: true });
      expect(await userAudit(operator.id)).toHaveLength(0);
      await refresh(session.cookie).expect(200);
    });

    it('activating yourself is allowed (no-op)', async () => {
      const { owner, token } = await newShop();

      const res = await activate(token, owner.id).expect(200);

      expect(res.body).toMatchObject({ isActive: true, isYou: true });
    });

    it("another shop's user → 404 and stays inactive", async () => {
      const otherShop = await fx.tenant();
      const stranger = await fx.user('operator', otherShop, {
        isActive: false,
      });

      await activate(tokens.ownerA, stranger.id).expect(404);
      await activate(tokens.ownerA, UNKNOWN_ID).expect(404);
      await activate(tokens.ownerA, 'not-a-uuid').expect(400);

      expect((await userRow(stranger.id)).isActive).toBe(false);
    });
  });

  describe('access', () => {
    const routes: [string, (token: string) => request.Test][] = [
      ['GET /staff', (t) => list(t)],
      ['PATCH /staff/:id/role', (t) => changeRole(t, ownerA.id, 'operator')],
      ['POST /staff/:id/deactivate', (t) => deactivate(t, ownerA.id)],
      ['POST /staff/:id/activate', (t) => activate(t, ownerA.id)],
    ];

    describe.each(['manager', 'operator', 'superAdmin'] as const)(
      '%s → 403',
      (who) => {
        it.each(routes)('%s', async (_name, call) => {
          const res = await call(tokens[who]).expect(403);
          expect(res.body.statusCode).toBe(403);
        });
      },
    );

    it.each([
      ['GET /staff', () => http().get('/staff')],
      [
        'PATCH /staff/:id/role',
        () =>
          http().patch(`/staff/${ownerA.id}/role`).send({ role: 'operator' }),
      ],
      [
        'POST /staff/:id/deactivate',
        () => http().post(`/staff/${ownerA.id}/deactivate`),
      ],
      [
        'POST /staff/:id/activate',
        () => http().post(`/staff/${ownerA.id}/activate`),
      ],
    ])('no token → 401: %s', async (_name, call) => {
      await call().expect(401);
    });

    afterAll(async () => {
      // Nothing above may have changed shop A's owner.
      expect(await userRow(ownerA.id)).toMatchObject({
        role: 'owner',
        isActive: true,
      });
    });
  });

  describe('ticket scenario: invite → accept → login → deactivate', () => {
    it('the operator is logged out and cannot log in again', async () => {
      const { tenantId, token } = await newShop();
      const phone = fx.phone();

      await http()
        .post('/staff/invitations')
        .set('Authorization', `Bearer ${token}`)
        .send({ phone, role: 'operator', method: 'link' })
        .expect(201);
      const message = sent.filter((m) => m.phone === phone).at(-1);
      const inviteToken = new URL(message!.url).searchParams.get('token');

      resetAuthThrottle();
      await http()
        .post('/auth/accept-invite')
        .send({
          token: inviteToken,
          name: 'Invited Operator',
          password: 'Staff-pass-123',
        })
        .expect(201);

      const session = await login(phone, 'Staff-pass-123');
      const staffId = session.body.user.id as string;
      expect(session.body.user).toMatchObject({
        role: 'operator',
        tenantId,
      });

      const staff = await list(token).expect(200);
      expect(staff.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: staffId,
            name: 'Invited Operator',
            phone,
            role: 'operator',
            isActive: true,
            lastLoginAt: expect.stringMatching(ISO),
          }),
        ]),
      );

      await deactivate(token, staffId).expect(200);

      const access = await me(session.accessToken).expect(403);
      expect(access.body.code).toBe('ACCOUNT_DISABLED');
      await refresh(session.cookie).expect(401);
      const signIn = await tryLogin(phone, 'Staff-pass-123').expect(403);
      expect(signIn.body.code).toBe('ACCOUNT_DISABLED');

      const after = await list(token).expect(200);
      expect(
        (after.body.data as { id: string; isActive: boolean }[]).find(
          (m) => m.id === staffId,
        )?.isActive,
      ).toBe(false);
    });
  });
});
