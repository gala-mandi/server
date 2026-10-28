import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import { and, eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { permissionsFor } from '../src/common/auth/permissions';
import type { Env } from '../src/config/env.schema';
import { auditLogs, invitations, tenants, users } from '../src/database/schema';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import {
  INVITE_SENDER,
  type InviteMessage,
} from '../src/modules/staff/invite-sender';
import {
  createInviteToken,
  hashInviteToken,
} from '../src/modules/staff/invite-token';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';
import { TenantProbeModule } from './support/tenant-probe.module';

const NEW_PASSWORD = 'Staff-pass-123';
const HOUR = 60 * 60 * 1000;

const MESSAGES = {
  invalid: 'This invite link is not valid',
  used: 'This invite has already been used. Sign in instead.',
  cancelled: 'This invite was cancelled. Ask your shop owner for a new one.',
  expired: 'This invite has expired. Ask your shop owner for a new one.',
};

/** The 400 body for a bad invite token: same shape for every code. */
function inviteError(code: string, message: string) {
  return {
    statusCode: 400,
    code,
    message,
    errors: [{ field: 'token', message }],
  };
}

function tokenOf(url: string): string {
  const token = new URL(url).searchParams.get('token');
  if (!token) throw new Error(`no token in ${url}`);
  return token;
}

describe('Staff invitations (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;
  const sent: InviteMessage[] = [];

  let shopA: string;
  let shopAName: string;
  let shopB: string;
  let ownerA: typeof users.$inferSelect;
  let ownerB: typeof users.$inferSelect;
  const tokens = {} as Record<
    'ownerA' | 'ownerB' | 'manager' | 'operator' | 'superAdmin',
    string
  >;

  const http = () => request(app.getHttpServer());

  /**
   * The accept limit is per IP, and every test here comes from one IP. The
   * in-memory storage keeps hit times in a private map next to `storage`.
   */
  function resetAuthThrottle(): void {
    const storage = app.get<ThrottlerStorageService>(getStorageToken(), {
      strict: false,
    });
    storage.storage.clear();
    (
      Reflect.get(storage, 'hitExpirations') as Map<string, unknown> | undefined
    )?.clear();
  }

  async function login(identifier: string, password = PASSWORD) {
    const res = await http()
      .post('/auth/login')
      .send({ identifier, password })
      .expect(200);
    return res.body as {
      accessToken: string;
      user: Record<string, any>;
    };
  }

  const invite = (token: string, body: Record<string, unknown>) =>
    http()
      .post('/staff/invitations')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const list = (token: string) =>
    http().get('/staff/invitations').set('Authorization', `Bearer ${token}`);

  const cancel = (token: string, id: string) =>
    http()
      .delete(`/staff/invitations/${id}`)
      .set('Authorization', `Bearer ${token}`);

  function accept(body: Record<string, unknown>) {
    resetAuthThrottle();
    return http().post('/auth/accept-invite').send(body);
  }

  /** Owner sends a link invite; returns the invitation and the link token. */
  async function sendLink(
    ownerToken: string,
    role: 'manager' | 'operator' = 'operator',
    phone = fx.phone(),
  ) {
    const res = await invite(ownerToken, {
      phone,
      role,
      method: 'link',
    }).expect(201);
    const message = sent.filter((m) => m.phone === phone).at(-1);
    if (!message) throw new Error(`no invite sent to ${phone}`);
    return {
      phone,
      id: res.body.invitation.id as string,
      token: tokenOf(message.url),
      body: res.body,
    };
  }

  async function invitationRow(id: string) {
    const [row] = await fx.db
      .select()
      .from(invitations)
      .where(eq(invitations.id, id));
    return row;
  }

  async function usersWithPhone(phone: string) {
    return fx.db.select().from(users).where(eq(users.phone, phone));
  }

  async function newShop() {
    const tenantId = await fx.tenant();
    const owner = await fx.user('owner', tenantId);
    const { accessToken } = await login(owner.phone);
    return { tenantId, owner, token: accessToken };
  }

  beforeAll(async () => {
    fx = new Fixtures();
    app = await createTestApp({
      imports: [TenantProbeModule],
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
    [{ name: shopAName }] = await fx.db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, shopA));
    ownerA = await fx.user('owner', shopA);
    ownerB = await fx.user('owner', shopB);
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

  describe('full flow: invite → accept → sign in', () => {
    let phone: string;
    let invitationId: string;
    let token: string;
    let staffToken: string;

    it('owner invites an operator by link', async () => {
      phone = fx.phone();
      const res = await invite(tokens.ownerA, {
        phone,
        role: 'operator',
        method: 'link',
      }).expect(201);

      const webAppUrl = app
        .get<ConfigService<Env, true>>(ConfigService)
        .get('WEB_APP_URL', { infer: true });
      expect(res.body).toEqual({
        method: 'link',
        inviteUrl: expect.stringMatching(/\/accept-invite\?token=[\w-]{40,}$/),
        invitation: {
          id: expect.any(String),
          phone,
          role: 'operator',
          status: 'pending',
          invitedBy: ownerA.id,
          expiresAt: expect.any(String),
          createdAt: expect.any(String),
        },
      });
      expect(res.body.inviteUrl.startsWith(webAppUrl.replace(/\/$/, ''))).toBe(
        true,
      );
      const { expiresAt, createdAt } = res.body.invitation as {
        expiresAt: string;
        createdAt: string;
      };
      expect(Date.parse(expiresAt) - Date.parse(createdAt)).toBeGreaterThan(
        48 * HOUR - 60_000,
      );
      expect(Date.parse(expiresAt) - Date.parse(createdAt)).toBeLessThan(
        48 * HOUR + 60_000,
      );

      const message = sent.find((m) => m.phone === phone);
      expect(message).toEqual({
        phone,
        role: 'operator',
        shopName: shopAName,
        url: res.body.inviteUrl,
      });
      invitationId = res.body.invitation.id;
      token = tokenOf(message!.url);
    });

    it('stores only the SHA-256 of the token', async () => {
      const row = await invitationRow(invitationId);

      expect(row).toMatchObject({
        tenantId: shopA,
        phone,
        role: 'operator',
        invitedBy: ownerA.id,
        acceptedAt: null,
        cancelledAt: null,
      });
      expect(row.tokenHash).toBe(hashInviteToken(token));
      expect(JSON.stringify(row)).not.toContain(token);
    });

    it('the staff member accepts with name and password', async () => {
      const res = await accept({
        token,
        name: 'New Operator',
        password: NEW_PASSWORD,
      }).expect(201);

      expect(res.body).toEqual({ phone, shopName: shopAName });
      expect((await invitationRow(invitationId)).acceptedAt).toBeInstanceOf(
        Date,
      );
    });

    it('signs in to the inviting shop with the invited role', async () => {
      const { accessToken, user } = await login(phone, NEW_PASSWORD);
      staffToken = accessToken;

      expect(user).toMatchObject({
        name: 'New Operator',
        phone,
        role: 'operator',
        tenantId: shopA,
        mustChangePassword: false,
        tenant: { id: shopA, name: shopAName },
      });
      expect([...user.permissions].sort()).toEqual(
        [...permissionsFor('operator')].sort(),
      );

      const me = await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${staffToken}`)
        .expect(200);
      expect(me.body).toMatchObject({
        phone,
        role: 'operator',
        tenantId: shopA,
      });
    });

    it('reaches its own shop only', async () => {
      const as = (path: string) =>
        http().get(path).set('Authorization', `Bearer ${staffToken}`);

      await http()
        .post('/test-probe/echo-tenant')
        .set('Authorization', `Bearer ${staffToken}`)
        .expect(201, { tenantId: shopA });
      await as(`/test-probe/users/${ownerA.id}`).expect(200);
      await as(`/test-probe/users/${ownerB.id}`).expect(404);
    });

    it('as an operator, cannot manage staff', async () => {
      await list(staffToken).expect(403);
    });

    it('the same link a second time → 400 INVITE_USED', async () => {
      const res = await accept({
        token,
        name: 'Second Try',
        password: NEW_PASSWORD,
      }).expect(400);

      expect(res.body).toEqual(inviteError('INVITE_USED', MESSAGES.used));
      expect(await usersWithPhone(phone)).toHaveLength(1);
    });
  });

  describe('single use under a race', () => {
    it('two accepts at the same time: exactly one 201', async () => {
      const { phone, token, id } = await sendLink(tokens.ownerA);

      const results = await Promise.all(
        ['Racer One', 'Racer Two'].map((name) =>
          http()
            .post('/auth/accept-invite')
            .send({ token, name, password: NEW_PASSWORD }),
        ),
      );

      expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
      const loser = results.find((r) => r.status === 400)!;
      expect(loser.body.code).toBe('INVITE_USED');
      expect(await usersWithPhone(phone)).toHaveLength(1);
      expect((await invitationRow(id)).acceptedAt).toBeInstanceOf(Date);
    });
  });

  describe('expiry', () => {
    it('an expired invite → 400 INVITE_EXPIRED with a clear message', async () => {
      const { phone, token, id } = await sendLink(tokens.ownerA);
      await fx.db
        .update(invitations)
        .set({ expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(invitations.id, id));

      const res = await accept({
        token,
        name: 'Too Late',
        password: NEW_PASSWORD,
      }).expect(400);

      expect(res.body).toEqual(inviteError('INVITE_EXPIRED', MESSAGES.expired));
      expect(await usersWithPhone(phone)).toHaveLength(0);
      expect((await invitationRow(id)).acceptedAt).toBeNull();
    });
  });

  describe('cancel', () => {
    it('cancels without deleting; the link stops working', async () => {
      const { phone, token, id } = await sendLink(tokens.ownerA);

      const res = await cancel(tokens.ownerA, id).expect(200);
      expect(res.body).toMatchObject({ id, phone, status: 'cancelled' });

      const row = await invitationRow(id);
      expect(row).toBeDefined();
      expect(row.cancelledAt).toBeInstanceOf(Date);

      const accepted = await accept({
        token,
        name: 'Cancelled Staff',
        password: NEW_PASSWORD,
      }).expect(400);
      expect(accepted.body).toEqual(
        inviteError('INVITE_CANCELLED', MESSAGES.cancelled),
      );
      expect(await usersWithPhone(phone)).toHaveLength(0);
    });

    it('cancelling twice → 200 both times, one audit row', async () => {
      const { id } = await sendLink(tokens.ownerA);

      await cancel(tokens.ownerA, id).expect(200);
      const first = (await invitationRow(id)).cancelledAt;
      const again = await cancel(tokens.ownerA, id).expect(200);

      expect(again.body.status).toBe('cancelled');
      expect((await invitationRow(id)).cancelledAt).toEqual(first);
      const rows = await fx.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entity, 'invitations'),
            eq(auditLogs.entityId, id),
            eq(auditLogs.action, 'update'),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenantId: shopA, userId: ownerA.id });
    });

    it('an accepted invite stays accepted', async () => {
      const { token, id } = await sendLink(tokens.ownerA);
      await accept({
        token,
        name: 'Joined Already',
        password: NEW_PASSWORD,
      }).expect(201);

      const res = await cancel(tokens.ownerA, id).expect(200);

      expect(res.body.status).toBe('accepted');
      expect((await invitationRow(id)).cancelledAt).toBeNull();
    });

    it('an unknown id → 404, a malformed id → 400', async () => {
      await cancel(
        tokens.ownerA,
        '00000000-0000-4000-8000-000000000000',
      ).expect(404);
      await cancel(tokens.ownerA, 'not-a-uuid').expect(400);
    });
  });

  describe('phone already has an account', () => {
    it.each(['link', 'password'])(
      'inviting a phone registered in another shop → 409 PHONE_TAKEN (%s)',
      async (method) => {
        const elsewhere = await fx.user('operator', shopB);

        for (const phone of [
          elsewhere.phone,
          // Same number written another way.
          `+92 ${elsewhere.phone.slice(1)}`,
        ]) {
          const res = await invite(tokens.ownerA, {
            phone,
            role: 'operator',
            method,
            name: 'Taken Phone',
          }).expect(409);

          expect(res.body).toMatchObject({
            statusCode: 409,
            code: 'PHONE_TAKEN',
          });
        }
        const rows = await fx.db
          .select()
          .from(invitations)
          .where(eq(invitations.phone, elsewhere.phone));
        expect(rows).toEqual([]);
        expect(await usersWithPhone(elsewhere.phone)).toHaveLength(1);
      },
    );

    it('inviting a phone of the own shop → 409 as well', async () => {
      await invite(tokens.ownerA, {
        phone: ownerA.phone,
        role: 'manager',
      }).expect(409);
    });

    it('the phone registered after the invite was sent → accept gives 409', async () => {
      const { phone, token, id } = await sendLink(tokens.ownerA);
      await fx.user('operator', shopB, { phone });

      const res = await accept({
        token,
        name: 'Late Joiner',
        password: NEW_PASSWORD,
      }).expect(409);

      expect(res.body).toMatchObject({ statusCode: 409, code: 'PHONE_TAKEN' });
      const [user] = await usersWithPhone(phone);
      expect(user.tenantId).toBe(shopB);
      expect((await invitationRow(id)).acceptedAt).toBeNull();
    });
  });

  describe('a new invite for the same phone', () => {
    it('cancels the pending one: its link stops working', async () => {
      const first = await sendLink(tokens.ownerA, 'operator');
      const second = await sendLink(tokens.ownerA, 'manager', first.phone);

      expect(second.token).not.toBe(first.token);
      expect((await invitationRow(first.id)).cancelledAt).toBeInstanceOf(Date);
      expect((await invitationRow(second.id)).cancelledAt).toBeNull();

      const old = await accept({
        token: first.token,
        name: 'Old Link',
        password: NEW_PASSWORD,
      }).expect(400);
      expect(old.body.code).toBe('INVITE_CANCELLED');

      await accept({
        token: second.token,
        name: 'New Link',
        password: NEW_PASSWORD,
      }).expect(201);
      const [user] = await usersWithPhone(first.phone);
      expect(user).toMatchObject({ role: 'manager', tenantId: shopA });
    });
  });

  describe('roles', () => {
    let pendingId: string;

    beforeAll(async () => {
      pendingId = (await sendLink(tokens.ownerA)).id;
    });

    it.each<[string, 'manager' | 'operator' | 'superAdmin']>([
      ['manager', 'manager'],
      ['operator', 'operator'],
      ['super_admin', 'superAdmin'],
    ])('%s → 403 on every staff endpoint', async (_role, who) => {
      const token = tokens[who];

      await invite(token, {
        phone: fx.phone(),
        role: 'operator',
        method: 'link',
      }).expect(403);
      await invite(token, {
        phone: fx.phone(),
        role: 'operator',
        method: 'password',
        name: 'Sneaky Staff',
      }).expect(403);
      await list(token).expect(403);
      await cancel(token, pendingId).expect(403);

      expect((await invitationRow(pendingId)).cancelledAt).toBeNull();
    });

    it('without a token → 401', async () => {
      await http().get('/staff/invitations').expect(401);
    });

    it.each<[string, string]>([
      ['owner', 'link'],
      ['owner', 'password'],
      ['super_admin', 'link'],
      ['super_admin', 'password'],
    ])('inviting as %s (%s) → 400', async (role, method) => {
      const phone = fx.phone();

      const res = await invite(tokens.ownerA, {
        phone,
        role,
        method,
        name: 'Power Grab',
      }).expect(400);

      expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual([
        'role',
      ]);
      expect(await usersWithPhone(phone)).toHaveLength(0);
    });

    it('an invalid phone → 400 on phone', async () => {
      const res = await invite(tokens.ownerA, {
        phone: 'call me',
        role: 'operator',
      }).expect(400);

      expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual([
        'phone',
      ]);
    });
  });

  describe('never trust the client', () => {
    it('a tenantId in the invite body is ignored', async () => {
      const phone = fx.phone();

      const res = await invite(tokens.ownerA, {
        phone,
        role: 'operator',
        tenantId: shopB,
        tenant_id: shopB,
      }).expect(201);

      expect(
        (await invitationRow(res.body.invitation.id as string)).tenantId,
      ).toBe(shopA);
    });

    it('role and tenantId in the accept body are ignored', async () => {
      const { phone, token } = await sendLink(tokens.ownerA, 'operator');

      await accept({
        token,
        name: 'Wants Owner',
        password: NEW_PASSWORD,
        role: 'owner',
        tenantId: shopB,
        tenant_id: shopB,
        mustChangePassword: false,
        phone: ownerB.phone,
      }).expect(201);

      const [user] = await usersWithPhone(phone);
      expect(user).toMatchObject({ role: 'operator', tenantId: shopA });
      const { user: session } = await login(phone, NEW_PASSWORD);
      expect(session).toMatchObject({ role: 'operator', tenantId: shopA });
    });
  });

  describe('token guessing', () => {
    it('unknown tokens → 400 INVITE_INVALID, same body every time', async () => {
      const { id } = await sendLink(tokens.ownerA);
      const storedHash = (await invitationRow(id)).tokenHash;

      for (const token of [
        createInviteToken().token, // right shape, never issued
        'A'.repeat(43),
        'not a token at all !!! ¯\\_(ツ)_/¯',
        storedHash, // a leaked hash is not a token
        `${createInviteToken().token}' or '1'='1`,
      ]) {
        const res = await accept({
          token,
          name: 'Guesser',
          password: NEW_PASSWORD,
        }).expect(400);
        expect(res.body).toEqual(
          inviteError('INVITE_INVALID', MESSAGES.invalid),
        );
      }
      expect((await invitationRow(id)).acceptedAt).toBeNull();
    });

    it('too-short and oversized tokens get the same INVITE_INVALID answer', async () => {
      for (const token of ['', 'abc', 'x'.repeat(19), 'x'.repeat(201)]) {
        const res = await accept({
          token,
          name: 'Guesser',
          password: NEW_PASSWORD,
        }).expect(400);
        expect(res.body).toEqual(
          inviteError('INVITE_INVALID', MESSAGES.invalid),
        );
      }
    });

    it('a missing token → 400 on token', async () => {
      for (const body of [{ name: 'Guesser', password: NEW_PASSWORD }]) {
        const res = await accept(body).expect(400);
        expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual([
          'token',
        ]);
      }
    });

    it('a weak password or missing name → 400 on that field', async () => {
      const { token, id } = await sendLink(tokens.ownerA);

      const weak = await accept({ token, name: 'Ok Name', password: 'short' });
      expect(weak.status).toBe(400);
      expect(weak.body.errors.map((e: { field: string }) => e.field)).toEqual([
        'password',
      ]);
      const noName = await accept({ token, password: NEW_PASSWORD });
      expect(noName.status).toBe(400);
      expect(noName.body.errors.map((e: { field: string }) => e.field)).toEqual(
        ['name'],
      );
      expect((await invitationRow(id)).acceptedAt).toBeNull();
    });

    it("a suspended shop's invite → 403 TENANT_SUSPENDED", async () => {
      const shop = await newShop();
      const { phone, token, id } = await sendLink(shop.token);
      await fx.db
        .update(tenants)
        .set({ status: 'suspended' })
        .where(eq(tenants.id, shop.tenantId));

      const res = await accept({
        token,
        name: 'Suspended Staff',
        password: NEW_PASSWORD,
      }).expect(403);

      expect(res.body).toMatchObject({
        statusCode: 403,
        code: 'TENANT_SUSPENDED',
      });
      expect(await usersWithPhone(phone)).toHaveLength(0);
      expect((await invitationRow(id)).acceptedAt).toBeNull();
    });

    it('accept is rate-limited per IP: the 6th try in a minute → 429', async () => {
      const { token } = await sendLink(tokens.ownerA);
      resetAuthThrottle();

      for (let i = 0; i < 5; i++) {
        await http()
          .post('/auth/accept-invite')
          .send({
            token: createInviteToken().token,
            name: 'Guesser',
            password: NEW_PASSWORD,
          })
          .expect(400);
      }
      // Even the right token waits now.
      const res = await http()
        .post('/auth/accept-invite')
        .send({ token, name: 'Guesser', password: NEW_PASSWORD })
        .expect(429);

      expect(res.body.message).toBe(
        'Too many attempts. Try again in a minute.',
      );
      expect(res.headers['retry-after']).toBeDefined();
      resetAuthThrottle();
    });
  });

  describe('temporary password instead of a link', () => {
    it('closes an open invite link for the same phone', async () => {
      const { phone, id } = await sendLink(tokens.ownerA);

      await invite(tokens.ownerA, {
        phone,
        role: 'operator',
        method: 'password',
        name: 'Now By Password',
      }).expect(201);

      expect((await invitationRow(id)).cancelledAt).not.toBeNull();
    });

    it('two at once for one phone: one account, one 409 (not 500)', async () => {
      const phone = fx.phone();
      const body = {
        phone,
        role: 'operator',
        method: 'password',
        name: 'Twin',
      };

      const results = await Promise.all([
        invite(tokens.ownerA, body),
        invite(tokens.ownerA, body),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)?.body.code).toBe(
        'PHONE_TAKEN',
      );
      expect(await usersWithPhone(phone)).toHaveLength(1);
    });

    it('creates the account now; the user must change the password', async () => {
      const phone = fx.phone();
      const sentBefore = sent.length;

      const res = await invite(tokens.ownerA, {
        phone,
        role: 'manager',
        method: 'password',
        name: 'Temp Manager',
      }).expect(201);

      expect(res.body).toEqual({
        method: 'password',
        user: {
          id: expect.any(String),
          name: 'Temp Manager',
          phone,
          role: 'manager',
        },
        temporaryPassword: expect.any(String),
      });
      expect(res.body.temporaryPassword.length).toBeGreaterThanOrEqual(8);
      expect(sent.length).toBe(sentBefore);

      const { accessToken, user } = await login(
        phone,
        res.body.temporaryPassword as string,
      );
      expect(user).toMatchObject({
        id: res.body.user.id,
        role: 'manager',
        tenantId: shopA,
        mustChangePassword: true,
      });
      const me = await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(me.body).toMatchObject({
        mustChangePassword: true,
        role: 'manager',
        tenantId: shopA,
      });
    });

    it('needs a name → 400 on name', async () => {
      const phone = fx.phone();

      const res = await invite(tokens.ownerA, {
        phone,
        role: 'operator',
        method: 'password',
      }).expect(400);

      expect(res.body.errors).toEqual([
        { field: 'name', message: "Enter the staff member's name" },
      ]);
      expect(await usersWithPhone(phone)).toHaveLength(0);
    });
  });

  describe('list', () => {
    it('shows pending, accepted, cancelled and expired invites of the own shop only', async () => {
      const shop = await newShop();
      const pending = await sendLink(shop.token);
      const accepted = await sendLink(shop.token, 'manager');
      const cancelled = await sendLink(shop.token);
      const expired = await sendLink(shop.token);
      const elsewhere = await sendLink(tokens.ownerB);

      await accept({
        token: accepted.token,
        name: 'Accepted Staff',
        password: NEW_PASSWORD,
      }).expect(201);
      await cancel(shop.token, cancelled.id).expect(200);
      await fx.db
        .update(invitations)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(invitations.id, expired.id));

      const res = await list(shop.token).expect(200);

      const data = res.body.data as Record<string, unknown>[];
      const byId = Object.fromEntries(data.map((i) => [i.id, i.status]));
      expect(byId).toEqual({
        [pending.id]: 'pending',
        [accepted.id]: 'accepted',
        [cancelled.id]: 'cancelled',
        [expired.id]: 'expired',
      });
      expect(byId).not.toHaveProperty(elsewhere.id);
      // Newest first, never the token or its hash.
      expect(data[0].id).toBe(expired.id);
      for (const item of data) {
        expect(Object.keys(item).sort()).toEqual(
          [
            'createdAt',
            'expiresAt',
            'id',
            'invitedBy',
            'phone',
            'role',
            'status',
          ].sort(),
        );
        expect(item.invitedBy).toBe(shop.owner.id);
      }
    });
  });

  describe('tenant isolation', () => {
    it("shop A's owner can neither list nor cancel shop B's invites", async () => {
      const ofB = await sendLink(tokens.ownerB);

      const listed = await list(tokens.ownerA).expect(200);
      expect(listed.body.data.map((i: { id: string }) => i.id)).not.toContain(
        ofB.id,
      );

      const res = await cancel(tokens.ownerA, ofB.id).expect(404);
      expect(res.body).toEqual({
        statusCode: 404,
        message: 'Invitation not found',
      });
      expect((await invitationRow(ofB.id)).cancelledAt).toBeNull();

      // Shop B's link still works, into shop B.
      await accept({
        token: ofB.token,
        name: 'Shop B Staff',
        password: NEW_PASSWORD,
      }).expect(201);
      const [user] = await usersWithPhone(ofB.phone);
      expect(user.tenantId).toBe(shopB);
    });

    it("every listed invite belongs to the caller's shop", async () => {
      await sendLink(tokens.ownerA);
      await sendLink(tokens.ownerB);

      for (const [token, tenantId] of [
        [tokens.ownerA, shopA],
        [tokens.ownerB, shopB],
      ]) {
        const res = await list(token).expect(200);
        const ids = (res.body.data as { id: string }[]).map((i) => i.id);
        expect(ids.length).toBeGreaterThan(0);
        const rows = await fx.db
          .select({ tenantId: invitations.tenantId })
          .from(invitations)
          .where(inArray(invitations.id, ids));
        expect(new Set(rows.map((r) => r.tenantId))).toEqual(
          new Set([tenantId]),
        );
      }
    });
  });

  describe('Row-Level Security on invitations', () => {
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
           join pg_policies p
             on p.tablename = c.relname and p.policyname = 'tenant_isolation'
          where c.oid = 'public.invitations'::regclass`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ rls: true, cmd: 'ALL' });
      expect(rows[0].roles).toContain('app_tenant');
      expect(rows[0].qual).toContain("current_setting('app.tenant_id'");
      expect(rows[0].with_check).toContain("current_setting('app.tenant_id'");
    });

    it("as app_tenant, shop A sees none of shop B's invites", async () => {
      const ofA = await sendLink(tokens.ownerA);
      const ofB = await sendLink(tokens.ownerB);

      const client = await fx.pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role app_tenant');
        await client.query("select set_config('app.tenant_id', $1, true)", [
          shopA,
        ]);

        const all = await client.query<{ tenant_id: string; id: string }>(
          'select id, tenant_id from invitations',
        );
        expect(all.rows.map((r) => r.id)).toContain(ofA.id);
        expect(new Set(all.rows.map((r) => r.tenant_id))).toEqual(
          new Set([shopA]),
        );

        const byId = await client.query(
          'select 1 from invitations where id = $1',
          [ofB.id],
        );
        expect(byId.rowCount).toBe(0);

        const updated = await client.query(
          'update invitations set cancelled_at = now() where id = $1',
          [ofB.id],
        );
        expect(updated.rowCount).toBe(0);

        await expect(
          client.query(
            `insert into invitations (tenant_id, phone, role, token_hash, invited_by, expires_at)
             values ($1, $2, 'operator', $3, $4, now() + interval '1 hour')`,
            [shopB, fx.phone(), createInviteToken().tokenHash, ownerB.id],
          ),
        ).rejects.toThrow(/row-level security policy/);
      } finally {
        await client.query('rollback');
        client.release();
      }
      expect((await invitationRow(ofB.id)).cancelledAt).toBeNull();
    });
  });

  describe('audit log', () => {
    async function auditOf(entityId: string) {
      return fx.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entityId, entityId))
        .orderBy(auditLogs.id);
    }

    it('invite create, accept and the new user are logged, secrets masked', async () => {
      const { phone, token, id } = await sendLink(tokens.ownerA, 'manager');
      const tokenHash = (await invitationRow(id)).tokenHash;
      await accept({
        token,
        name: 'Audited Staff',
        password: NEW_PASSWORD,
      }).expect(201);
      const [user] = await usersWithPhone(phone);

      const inviteRows = await auditOf(id);
      expect(inviteRows.map((r) => [r.action, r.tenantId, r.userId])).toEqual([
        ['create', shopA, ownerA.id],
        ['update', shopA, user.id],
      ]);
      expect(inviteRows[0].after).toMatchObject({
        id,
        phone,
        role: 'manager',
        tokenHash: '[REDACTED]',
      });
      expect(inviteRows[1].after).toHaveProperty('acceptedAt');

      const userRows = await auditOf(user.id);
      expect(userRows.map((r) => [r.action, r.tenantId])).toEqual([
        ['create', shopA],
      ]);
      expect(userRows[0].after).toMatchObject({
        id: user.id,
        phone,
        role: 'manager',
        passwordHash: '[REDACTED]',
      });

      const dump = JSON.stringify([...inviteRows, ...userRows]);
      expect(dump).not.toContain(token);
      expect(dump).not.toContain(tokenHash);
      expect(dump).not.toContain(user.passwordHash);
      expect(dump).not.toContain(NEW_PASSWORD);
    });

    it('cancel is logged by the owner', async () => {
      const { id } = await sendLink(tokens.ownerA);
      await cancel(tokens.ownerA, id).expect(200);

      const rows = await auditOf(id);
      expect(rows.map((r) => [r.action, r.userId])).toEqual([
        ['create', ownerA.id],
        ['update', ownerA.id],
      ]);
      expect(rows[1].before).toEqual({ cancelledAt: null });
      expect(rows[1].after).toEqual({ cancelledAt: expect.any(String) });
    });

    it('a replaced invite is logged as cancelled', async () => {
      const first = await sendLink(tokens.ownerA);
      await sendLink(tokens.ownerA, 'operator', first.phone);

      const rows = await auditOf(first.id);
      expect(rows.map((r) => r.action)).toEqual(['create', 'update']);
    });

    it('a user made with a temporary password is logged, password masked', async () => {
      const res = await invite(tokens.ownerA, {
        phone: fx.phone(),
        role: 'operator',
        method: 'password',
        name: 'Temp Audited',
      }).expect(201);

      const rows = await auditOf(res.body.user.id as string);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entity: 'users',
        action: 'create',
        tenantId: shopA,
        userId: ownerA.id,
      });
      expect(rows[0].after).toMatchObject({
        passwordHash: '[REDACTED]',
        mustChangePassword: true,
      });
      expect(JSON.stringify(rows)).not.toContain(res.body.temporaryPassword);
    });
  });
});
