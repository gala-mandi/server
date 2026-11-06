import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { addDays, karachiDate } from '../src/common/time/karachi-date';
import {
  auditLogs,
  plans,
  tenantSubscriptions,
  users,
} from '../src/database/schema';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import { INVITE_SENDER } from '../src/modules/staff/invite-sender';
import { TRIAL_DAYS } from '../src/modules/subscriptions/access-state';
import type { Plan } from '../src/modules/subscriptions/plans.dto';
import { SubscriptionJobsService } from '../src/modules/subscriptions/subscription-jobs.service';
import type {
  ShopSubscription,
  SubscriptionView,
} from '../src/modules/subscriptions/subscriptions.dto';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';

const TODAY = karachiDate();
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const TAG = randomBytes(3).toString('hex');
const READ_ONLY = {
  statusCode: 403,
  code: 'SUBSCRIPTION_READ_ONLY',
};

type Token = 'admin' | 'owner' | 'manager' | 'operator';

describe('Plans and subscriptions (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;
  const tokens = {} as Record<Token, string>;
  let shopA: string;

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string | null) =>
    token ? req.set('Authorization', `Bearer ${token}`) : req;

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

  /** A shop with an owner, signed in. */
  async function shop() {
    const tenantId = await fx.tenant();
    const owner = await fx.user('owner', tenantId);
    return { tenantId, owner, token: await login(owner.phone) };
  }

  /** Replaces the shop's subscriptions with one ending on `endsOn`. */
  async function endsOn(tenantId: string, date: string, graceDays = 7) {
    await fx.clearSubscriptions(tenantId);
    return fx.subscription(tenantId, {
      endsOn: date,
      startsOn: addDays(date, -30),
      graceDays,
    });
  }

  const newTrader = (token: string) =>
    as(http().post('/traders'), token).send({
      type: 'kissan',
      name: `Kissan ${TAG}`,
    });

  const plan = (body: Record<string, unknown> = {}) =>
    as(http().post('/admin/plans'), tokens.admin).send({
      name: `Plan ${TAG} ${randomBytes(2).toString('hex')}`,
      maxUsers: 4,
      maxBranches: 2,
      priceMonthly: '1500',
      ...body,
    });

  async function createPlan(body: Record<string, unknown> = {}) {
    const res = await plan(body).expect(201);
    fx.trackPlan(res.body.id as string);
    return res.body as Plan;
  }

  beforeAll(async () => {
    fx = new Fixtures();
    app = await createTestApp({
      override: (builder) =>
        builder
          .overrideProvider(OTP_SENDER)
          .useValue({ send: () => Promise.resolve() })
          .overrideProvider(INVITE_SENDER)
          .useValue({ send: () => Promise.resolve() }),
    });

    shopA = await fx.tenant();
    const owner = await fx.user('owner', shopA);
    const manager = await fx.user('manager', shopA);
    const operator = await fx.user('operator', shopA);
    const admin = await fx.user('super_admin', null);
    tokens.owner = await login(owner.phone);
    tokens.manager = await login(manager.phone);
    tokens.operator = await login(operator.phone);
    tokens.admin = await login(admin.phone);
  });

  afterAll(async () => {
    await app.close();
    await fx.cleanup();
  });

  describe('plans CRUD /admin/plans', () => {
    it('lists the starting plans Trial, Basic and Pro', async () => {
      const res = await as(
        http().get('/admin/plans?limit=100'),
        tokens.admin,
      ).expect(200);
      const names = (res.body.data as Plan[]).map((p) => p.name);
      expect(names).toEqual(expect.arrayContaining(['Trial', 'Basic', 'Pro']));
      const trial = (res.body.data as Plan[]).find((p) => p.name === 'Trial')!;
      expect(trial).toMatchObject({ isTrial: true, isActive: true });
      expect(trial.priceMonthly).toMatch(/^\d+\.\d{2}$/);
      expect(res.body.meta).toMatchObject({ page: 1, limit: 100 });
    });

    it('creates a plan: price as a 2-decimal string, audited', async () => {
      const created = await createPlan({ priceMonthly: '1500' });
      expect(created).toMatchObject({
        maxUsers: 4,
        maxBranches: 2,
        priceMonthly: '1500.00',
        isActive: true,
        isTrial: false,
        shopCount: 0,
      });
      const [log] = await fx.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, created.id),
            eq(auditLogs.action, 'create'),
          ),
        );
      expect(log).toMatchObject({ entity: 'plans', tenantId: null });
    });

    it('refuses a duplicate name (any case) with PLAN_NAME_TAKEN', async () => {
      const created = await createPlan();
      const res = await plan({ name: created.name.toUpperCase() }).expect(409);
      expect(res.body.code).toBe('PLAN_NAME_TAKEN');
    });

    it.each([
      ['no users', { maxUsers: 0 }, 'maxUsers'],
      ['a float price', { priceMonthly: '12.345' }, 'priceMonthly'],
      ['a number price', { priceMonthly: 1500 }, 'priceMonthly'],
      ['a short name', { name: 'x' }, 'name'],
    ])('400 for %s', async (_label, body, field) => {
      const res = await plan(body).expect(400);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field })]),
      );
    });

    it('updates limits and price', async () => {
      const created = await createPlan();
      const res = await as(
        http().patch(`/admin/plans/${created.id}`),
        tokens.admin,
      )
        .send({ maxUsers: 9, priceMonthly: '2999.50' })
        .expect(200);
      expect(res.body).toMatchObject({ maxUsers: 9, priceMonthly: '2999.50' });
    });

    it("the Trial plan can't be renamed, deactivated or deleted", async () => {
      const [trial] = await fx.db
        .select()
        .from(plans)
        .where(eq(plans.name, 'Trial'));
      for (const body of [{ name: 'Free' }, { isActive: false }]) {
        const res = await as(
          http().patch(`/admin/plans/${trial.id}`),
          tokens.admin,
        )
          .send(body)
          .expect(409);
        expect(res.body.code).toBe('TRIAL_PLAN_LOCKED');
      }
      const res = await as(
        http().delete(`/admin/plans/${trial.id}`),
        tokens.admin,
      ).expect(409);
      expect(res.body.code).toBe('TRIAL_PLAN_LOCKED');
    });

    it('deletes a plan no shop used', async () => {
      const created = await createPlan();
      const res = await as(
        http().delete(`/admin/plans/${created.id}`),
        tokens.admin,
      ).expect(200);
      expect(res.body.result).toBe('deleted');
      await as(http().get(`/admin/plans/${created.id}`), tokens.admin).expect(
        404,
      );
    });

    it('deactivates (keeps) a plan a shop has used', async () => {
      const created = await createPlan();
      const used = await fx.tenant();
      await fx.subscription(used, { planId: created.id });
      const res = await as(
        http().delete(`/admin/plans/${created.id}`),
        tokens.admin,
      ).expect(200);
      expect(res.body).toMatchObject({
        result: 'deactivated',
        plan: { id: created.id, isActive: false },
      });
      await as(http().get(`/admin/plans/${created.id}`), tokens.admin).expect(
        200,
      );
    });

    it('404 for an unknown plan', async () => {
      await as(http().get(`/admin/plans/${UNKNOWN_ID}`), tokens.admin).expect(
        404,
      );
      await as(http().patch(`/admin/plans/${UNKNOWN_ID}`), tokens.admin)
        .send({ maxUsers: 3 })
        .expect(404);
    });

    it.each<Token>(['owner', 'manager', 'operator'])(
      'super-admin only: %s gets 403',
      async (who) => {
        const created = await createPlan();
        await as(http().get('/admin/plans'), tokens[who]).expect(403);
        await as(http().post('/admin/plans'), tokens[who])
          .send({ name: 'Mine', maxUsers: 99, priceMonthly: '0' })
          .expect(403);
        await as(http().patch(`/admin/plans/${created.id}`), tokens[who])
          .send({ maxUsers: 99 })
          .expect(403);
        await as(
          http().delete(`/admin/plans/${created.id}`),
          tokens[who],
        ).expect(403);
      },
    );

    it('401 without a token', async () => {
      await http().get('/admin/plans').expect(401);
    });
  });

  describe('assign and extend /admin/tenants/:id/subscription', () => {
    it('a new shop made through the API starts on a 14-day Trial', async () => {
      const res = await as(http().post('/admin/tenants'), tokens.admin)
        .send({
          name: `Trial Shop ${TAG}`,
          phone: fx.phone(),
          owner: { name: 'Trial Owner', phone: fx.phone() },
        })
        .expect(201);
      fx.trackTenant(res.body.tenant.id as string);
      expect(res.body.tenant.subscription).toMatchObject({
        plan: { name: 'Trial' },
        startsOn: TODAY,
        endsOn: addDays(TODAY, TRIAL_DAYS),
        graceDays: 7,
        status: 'active',
        state: 'active',
        daysLeft: TRIAL_DAYS,
        usersUsed: 1,
      });
    });

    it('assigns a plan: the running one is cancelled, access follows at once', async () => {
      const { tenantId, token } = await shop();
      const [old] = await fx.db
        .select()
        .from(tenantSubscriptions)
        .where(eq(tenantSubscriptions.tenantId, tenantId));
      const pro = await createPlan({ maxUsers: 10 });

      const res = await as(
        http().post(`/admin/tenants/${tenantId}/subscription`),
        tokens.admin,
      )
        .send({ planId: pro.id, endsOn: addDays(TODAY, 30), graceDays: 5 })
        .expect(201);
      const view = res.body as SubscriptionView;
      expect(view).toMatchObject({
        plan: { id: pro.id, maxUsers: 10 },
        startsOn: TODAY,
        endsOn: addDays(TODAY, 30),
        graceDays: 5,
        graceEndsOn: addDays(TODAY, 35),
        state: 'active',
        daysLeft: 30,
      });

      const [oldAfter] = await fx.db
        .select()
        .from(tenantSubscriptions)
        .where(eq(tenantSubscriptions.id, old.id));
      expect(oldAfter.status).toBe('cancelled');

      const mine = await as(http().get('/subscription'), token).expect(200);
      expect((mine.body as ShopSubscription).subscription?.plan.id).toBe(
        pro.id,
      );

      const detail = await as(
        http().get(`/admin/tenants/${tenantId}`),
        tokens.admin,
      ).expect(200);
      expect(detail.body.subscription).toMatchObject({ id: view.id });
    });

    it('the shops list shows plan, end date and state', async () => {
      const { tenantId } = await shop();
      await endsOn(tenantId, addDays(TODAY, -2));
      const res = await as(
        http().get('/admin/tenants?limit=100&sort=-createdAt'),
        tokens.admin,
      ).expect(200);
      const row = (
        res.body.data as {
          id: string;
          subscription: Record<string, unknown> | null;
        }[]
      ).find((t) => t.id === tenantId);
      expect(row?.subscription).toMatchObject({
        endsOn: addDays(TODAY, -2),
        state: 'grace',
        daysLeft: 0,
      });
    });

    it.each([
      [
        'an end before the start',
        { startsOn: addDays(TODAY, 5), endsOn: addDays(TODAY, 2) },
      ],
      ['an end in the past', { endsOn: addDays(TODAY, -1) }],
      ['a bad date', { endsOn: '2026-02-30' }],
    ])('assign: 400 for %s', async (_label, body) => {
      const created = await createPlan();
      await as(
        http().post(`/admin/tenants/${shopA}/subscription`),
        tokens.admin,
      )
        .send({ planId: created.id, ...body })
        .expect(400);
    });

    it('assign: 409 PLAN_INACTIVE for a deactivated plan', async () => {
      const off = await createPlan({ isActive: false });
      const res = await as(
        http().post(`/admin/tenants/${shopA}/subscription`),
        tokens.admin,
      )
        .send({ planId: off.id, endsOn: addDays(TODAY, 10) })
        .expect(409);
      expect(res.body.code).toBe('PLAN_INACTIVE');
    });

    it('assign and extend: 404 for an unknown shop', async () => {
      const created = await createPlan();
      await as(
        http().post(`/admin/tenants/${UNKNOWN_ID}/subscription`),
        tokens.admin,
      )
        .send({ planId: created.id, endsOn: addDays(TODAY, 10) })
        .expect(404);
      await as(
        http().patch(`/admin/tenants/${UNKNOWN_ID}/subscription`),
        tokens.admin,
      )
        .send({ endsOn: addDays(TODAY, 10) })
        .expect(404);
    });

    it('extend: the new end date must be after the current one', async () => {
      const { tenantId } = await shop();
      await endsOn(tenantId, addDays(TODAY, 10));
      const res = await as(
        http().patch(`/admin/tenants/${tenantId}/subscription`),
        tokens.admin,
      )
        .send({ endsOn: addDays(TODAY, 10) })
        .expect(400);
      expect(res.body.errors).toEqual([
        expect.objectContaining({ field: 'endsOn' }),
      ]);
    });

    it.each<Token>(['owner', 'manager', 'operator'])(
      'super-admin only: %s gets 403 on assign and extend',
      async (who) => {
        const created = await createPlan();
        await as(
          http().post(`/admin/tenants/${shopA}/subscription`),
          tokens[who],
        )
          .send({ planId: created.id, endsOn: addDays(TODAY, 300) })
          .expect(403);
        await as(
          http().patch(`/admin/tenants/${shopA}/subscription`),
          tokens[who],
        )
          .send({ endsOn: addDays(TODAY, 300) })
          .expect(403);
      },
    );
  });

  describe('read-only mode after the grace period', () => {
    it('trial ended 8 days ago (7-day grace): writes refused, reads work', async () => {
      const { tenantId, token } = await shop();
      await endsOn(tenantId, addDays(TODAY, -8));

      const res = await newTrader(token).expect(403);
      expect(res.body).toMatchObject(READ_ONLY);
      await as(http().patch('/settings'), token)
        .send({ displayName: 'Changed' })
        .expect(403);
      await as(http().post('/staff/invitations'), token)
        .send({ phone: fx.phone(), role: 'operator', method: 'link' })
        .expect(403);
      await as(http().put(`/rates/${TODAY}`), token)
        .send({ rates: [] })
        .expect(403);

      // Viewing (and so printing) keeps working.
      await as(http().get('/traders'), token).expect(200);
      await as(http().get('/settings'), token).expect(200);
      await as(http().get('/purchases'), token).expect(200);
      const mine = await as(http().get('/subscription'), token).expect(200);
      expect(mine.body).toMatchObject({
        today: TODAY,
        state: 'read_only',
        subscription: {
          endsOn: addDays(TODAY, -8),
          graceEndsOn: addDays(TODAY, -1),
          daysLeft: 0,
          graceDaysLeft: 0,
        },
      });
    });

    it('sign-in, refresh, me, change password and sign-out still work', async () => {
      const { tenantId, owner } = await shop();
      await endsOn(tenantId, addDays(TODAY, -30));

      resetThrottle();
      const login = await http()
        .post('/auth/login')
        .send({ identifier: owner.phone, password: PASSWORD })
        .expect(200);
      const token = login.body.accessToken as string;
      const cookie = (login.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('refresh_token='))!
        .split(';')[0];

      await as(http().get('/auth/me'), token).expect(200);
      resetThrottle();
      const refreshed = await http()
        .post('/auth/refresh')
        .set('Cookie', cookie)
        .expect(200);
      const fresh = refreshed.body.accessToken as string;
      await as(http().post('/auth/change-password'), fresh)
        .send({ currentPassword: PASSWORD, newPassword: 'New-pass-12345' })
        .expect(200);
      await as(http().post('/auth/logout'), fresh).expect(204);
    });

    it('last day of grace: full access; the day after: read-only', async () => {
      const { tenantId, token } = await shop();
      await endsOn(tenantId, addDays(TODAY, -7));
      await newTrader(token).expect(201);
      const grace = await as(http().get('/subscription'), token).expect(200);
      expect(grace.body).toMatchObject({
        state: 'grace',
        subscription: { graceDaysLeft: 0 },
      });

      await endsOn(tenantId, addDays(TODAY, -8));
      await newTrader(token).expect(403);
    });

    it('in grace (ended 3 days ago): everything still works', async () => {
      const { tenantId, token } = await shop();
      await endsOn(tenantId, addDays(TODAY, -3));
      await newTrader(token).expect(201);
      const mine = await as(http().get('/subscription'), token).expect(200);
      expect(mine.body).toMatchObject({
        state: 'grace',
        subscription: { graceDaysLeft: 4, status: 'active' },
      });
    });

    it('super-admin extends the plan: full access restored immediately (same token)', async () => {
      const { tenantId, token } = await shop();
      await endsOn(tenantId, addDays(TODAY, -20));
      await newTrader(token).expect(403);

      const res = await as(
        http().patch(`/admin/tenants/${tenantId}/subscription`),
        tokens.admin,
      )
        .send({ endsOn: addDays(TODAY, 30) })
        .expect(200);
      expect(res.body).toMatchObject({
        endsOn: addDays(TODAY, 30),
        status: 'active',
        state: 'active',
      });

      await newTrader(token).expect(201);
      const [log] = await fx.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.tenantId, tenantId),
            eq(auditLogs.entity, 'tenant_subscriptions'),
            eq(auditLogs.action, 'update'),
          ),
        );
      expect(log.after).toMatchObject({ endsOn: addDays(TODAY, 30) });
    });

    it('a shop with no subscription at all is read-only', async () => {
      const { tenantId, token } = await shop();
      await fx.clearSubscriptions(tenantId);
      await newTrader(token).expect(403);
      const mine = await as(http().get('/subscription'), token).expect(200);
      expect(mine.body).toEqual({
        today: TODAY,
        state: 'read_only',
        subscription: null,
      });
    });

    it('super-admin is never affected', async () => {
      const { tenantId } = await shop();
      await endsOn(tenantId, addDays(TODAY, -30));
      await createPlan();
      await as(http().patch(`/admin/tenants/${tenantId}`), tokens.admin)
        .send({ city: 'Sahiwal' })
        .expect(200);
    });
  });

  describe('max users', () => {
    async function limitedShop(maxUsers: number) {
      const s = await shop();
      const limited = await fx.plan({ maxUsers });
      await fx.clearSubscriptions(s.tenantId);
      await fx.subscription(s.tenantId, { planId: limited.id });
      return { ...s, plan: limited };
    }
    const invite = (token: string, body: Record<string, unknown> = {}) =>
      as(http().post('/staff/invitations'), token).send({
        phone: fx.phone(),
        role: 'operator',
        method: 'link',
        ...body,
      });

    it('invite blocked with an upgrade message once the plan is full', async () => {
      const { token } = await limitedShop(2);
      // Owner + one pending invite = 2 of 2.
      const first = await invite(token).expect(201);

      const blocked = await invite(token).expect(403);
      expect(blocked.body).toMatchObject({
        code: 'PLAN_USER_LIMIT',
        message:
          'Your plan allows 2 users. Upgrade your plan to add more staff.',
      });
      await invite(token, { method: 'password', name: 'Staff' }).expect(403);

      const mine = await as(http().get('/subscription'), token).expect(200);
      expect(mine.body.subscription).toMatchObject({
        usersUsed: 2,
        plan: { maxUsers: 2 },
      });

      // Re-inviting the same phone replaces its invite: no extra seat.
      await invite(token, { phone: first.body.invitation.phone }).expect(201);

      // Cancelling the invite frees the seat.
      const list = await as(http().get('/staff/invitations'), token).expect(
        200,
      );
      const pending = (list.body.data as { id: string; status: string }[]).find(
        (i) => i.status === 'pending',
      )!;
      await as(http().delete(`/staff/invitations/${pending.id}`), token).expect(
        200,
      );
      await invite(token, { method: 'password', name: 'Staff' }).expect(201);
    });

    it('re-activating a user takes a seat too', async () => {
      const { tenantId, token } = await limitedShop(2);
      const staff = await fx.user('operator', tenantId, { isActive: false });
      await invite(token).expect(201);
      const res = await as(
        http().post(`/staff/${staff.id}/activate`),
        token,
      ).expect(403);
      expect(res.body.code).toBe('PLAN_USER_LIMIT');
    });

    it('accepting an invite after the plan was lowered is refused', async () => {
      const { token, plan: limited } = await limitedShop(3);
      const sent = await invite(token).expect(201);
      await fx.db
        .update(plans)
        .set({ maxUsers: 1 })
        .where(eq(plans.id, limited.id));

      resetThrottle();
      const res = await http()
        .post('/auth/accept-invite')
        .send({
          token: new URL(sent.body.inviteUrl as string).searchParams.get(
            'token',
          ),
          name: 'Late Staff',
          password: 'Staff-pass-123',
        })
        .expect(403);
      expect(res.body.code).toBe('PLAN_USER_LIMIT');
      const created = await fx.db
        .select()
        .from(users)
        .where(eq(users.phone, sent.body.invitation.phone as string));
      expect(created).toHaveLength(0);
    });

    it('a roomier plan lets the invite through at once', async () => {
      const { tenantId, token } = await limitedShop(1);
      await invite(token).expect(403);
      const bigger = await createPlan({ maxUsers: 5 });
      await as(
        http().post(`/admin/tenants/${tenantId}/subscription`),
        tokens.admin,
      )
        .send({ planId: bigger.id, endsOn: addDays(TODAY, 30) })
        .expect(201);
      await invite(token).expect(201);
    });
  });

  describe('tenant isolation', () => {
    it("each shop sees only its own plan; another shop's read-only mode doesn't spill over", async () => {
      const a = await shop();
      const b = await shop();
      const planA = await createPlan({ maxUsers: 7 });
      await fx.clearSubscriptions(a.tenantId);
      await fx.subscription(a.tenantId, { planId: planA.id });
      await endsOn(b.tenantId, addDays(TODAY, -30));

      const mineA = await as(http().get('/subscription'), a.token).expect(200);
      const mineB = await as(http().get('/subscription'), b.token).expect(200);
      expect(mineA.body).toMatchObject({
        state: 'active',
        subscription: { plan: { id: planA.id } },
      });
      expect(mineB.body.state).toBe('read_only');
      expect(mineB.body.subscription.plan.id).not.toBe(planA.id);

      await newTrader(a.token).expect(201);
      await newTrader(b.token).expect(403);
    });

    it('a tenant_id in the body or query is ignored', async () => {
      const a = await shop();
      const b = await shop();
      await endsOn(b.tenantId, addDays(TODAY, -30));
      const res = await as(
        http().get(`/subscription?tenant_id=${a.tenantId}`),
        b.token,
      ).expect(200);
      expect(res.body.state).toBe('read_only');
      await as(http().post('/traders'), b.token)
        .send({ type: 'kissan', name: 'Sneaky', tenant_id: a.tenantId })
        .expect(403);
    });

    it('RLS: a shop session reads only its own subscriptions and writes none', async () => {
      const a = await shop();
      const b = await shop();
      const client = await fx.pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role app_tenant');
        await client.query("select set_config('app.tenant_id', $1, true)", [
          a.tenantId,
        ]);
        const { rows } = await client.query<{ tenant_id: string }>(
          'select tenant_id from tenant_subscriptions',
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.tenant_id === a.tenantId)).toBe(true);
        // Shops may read plans (for limits) but not change them.
        const planRows = await client.query('select id from plans limit 1');
        expect(planRows.rows).toHaveLength(1);
        await expect(
          client.query(
            `update tenant_subscriptions set ends_on = ends_on + 365 where tenant_id = $1`,
            [a.tenantId],
          ),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await client.query('rollback');
        client.release();
      }
      const client2 = await fx.pool.connect();
      try {
        await client2.query('begin');
        await client2.query('set local role app_tenant');
        await expect(
          client2.query(`update plans set max_users = 1000`),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await client2.query('rollback');
        client2.release();
      }
      expect(b.tenantId).not.toBe(a.tenantId);
    });

    it('managers and operators can read their shop plan', async () => {
      for (const who of ['manager', 'operator'] as const) {
        const res = await as(http().get('/subscription'), tokens[who]).expect(
          200,
        );
        expect(res.body.subscription).not.toBeNull();
      }
    });

    it('super-admin has no shop: GET /subscription is 403', async () => {
      await as(http().get('/subscription'), tokens.admin).expect(403);
    });
  });

  describe('daily job', () => {
    const jobs = () => app.get(SubscriptionJobsService);
    const reminders = (subscriptionId: string) =>
      fx.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, subscriptionId),
            eq(auditLogs.action, 'remind'),
          ),
        );

    it('expires lapsed rows and reminds 7, 3 and 1 days ahead; a second run changes nothing', async () => {
      const lapsed = await endsOn(await fx.tenant(), addDays(TODAY, -1));
      const in7 = await endsOn(await fx.tenant(), addDays(TODAY, 7));
      const in3 = await endsOn(await fx.tenant(), addDays(TODAY, 3));
      const in1 = await endsOn(await fx.tenant(), addDays(TODAY, 1));
      const in5 = await endsOn(await fx.tenant(), addDays(TODAY, 5));

      const first = await jobs().run(TODAY);
      expect(first.expired).toBeGreaterThanOrEqual(1);
      expect(first.reminded).toBeGreaterThanOrEqual(3);

      const [lapsedRow] = await fx.db
        .select()
        .from(tenantSubscriptions)
        .where(eq(tenantSubscriptions.id, lapsed.id));
      expect(lapsedRow.status).toBe('expired');
      for (const [sub, days] of [
        [in7, 7],
        [in3, 3],
        [in1, 1],
      ] as const) {
        const rows = await reminders(sub.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ tenantId: sub.tenantId, userId: null });
        expect(rows[0].after).toMatchObject({
          daysLeft: days,
          endsOn: sub.endsOn,
        });
      }
      expect(await reminders(in5.id)).toHaveLength(0);

      // Same day again (e.g. a restart): nothing new.
      await jobs().run(TODAY);
      for (const sub of [in7, in3, in1]) {
        expect(await reminders(sub.id)).toHaveLength(1);
      }
      const expiryLogs = await fx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityId, lapsed.id),
            eq(auditLogs.action, 'update'),
          ),
        );
      expect(expiryLogs[0].n).toBe(1);
    });

    it('an expired (by the job) shop in grace still works, and extending makes it active', async () => {
      const { tenantId, token } = await shop();
      const sub = await endsOn(tenantId, addDays(TODAY, -2));
      await jobs().run(TODAY);
      const mine = await as(http().get('/subscription'), token).expect(200);
      expect(mine.body).toMatchObject({
        state: 'grace',
        subscription: { id: sub.id, status: 'expired' },
      });
      await newTrader(token).expect(201);

      await as(
        http().patch(`/admin/tenants/${tenantId}/subscription`),
        tokens.admin,
      )
        .send({ endsOn: addDays(TODAY, 60) })
        .expect(200);
      const after = await as(http().get('/subscription'), token).expect(200);
      expect(after.body.subscription).toMatchObject({
        status: 'active',
        state: 'active',
      });
    });
  });
});
