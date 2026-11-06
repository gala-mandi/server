import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { karachiDate } from '../../common/time/karachi-date';
import { PlatformDatabase } from '../../database/platform-database';
import { plans, tenantSubscriptions, tenants } from '../../database/schema';
import { TenantDatabase } from '../../database/tenant-database';
import { accessFor, type AccessState, stateOf } from './access-state';
import { noSubscription, planInactive } from './subscription-errors';
import {
  type CurrentSubscription,
  currentSubscription,
  usersUsed,
} from './subscription-queries';
import type {
  AssignSubscriptionInput,
  ExtendSubscriptionInput,
  ShopSubscription,
  SubscriptionBrief,
  SubscriptionView,
} from './subscriptions.dto';

type Executor = PgDatabase<any, any, any>;

const fieldError = (field: string, message: string) =>
  new BadRequestException({
    message: 'Validation failed',
    errors: [{ field, message }],
  });

export function toSubscriptionView(
  { subscription, plan }: CurrentSubscription,
  today: string,
  used: number,
): SubscriptionView {
  return {
    id: subscription.id,
    plan: {
      id: plan.id,
      name: plan.name,
      maxUsers: plan.maxUsers,
      maxBranches: plan.maxBranches,
      priceMonthly: plan.priceMonthly,
    },
    startsOn: subscription.startsOn,
    endsOn: subscription.endsOn,
    graceDays: subscription.graceDays,
    status: subscription.status,
    ...accessFor(subscription, today),
    usersUsed: used,
  };
}

/** Reads and changes shops' subscriptions. */
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly platform: PlatformDatabase,
  ) {}

  /** The signed-in shop's plan, dates and access state (for its banner). */
  forShop(today = karachiDate()): Promise<ShopSubscription> {
    return this.tenantDb.transaction(async ({ tx, tenantId }) => {
      const current = await currentSubscription(tx, tenantId);
      return {
        today,
        state: stateOf(current?.subscription ?? null, today),
        subscription: current
          ? toSubscriptionView(current, today, await usersUsed(tx, tenantId))
          : null,
      };
    });
  }

  /** What the signed-in shop may do today. */
  accessState(today = karachiDate()): Promise<AccessState> {
    return this.tenantDb.transaction(async ({ tx, tenantId }) => {
      const current = await currentSubscription(tx, tenantId);
      return stateOf(current?.subscription ?? null, today);
    });
  }

  /** For the admin shop page (inside a platform transaction). */
  async viewFor(
    db: Executor,
    tenantId: string,
    today = karachiDate(),
  ): Promise<SubscriptionView | null> {
    const current = await currentSubscription(db, tenantId);
    return current
      ? toSubscriptionView(current, today, await usersUsed(db, tenantId))
      : null;
  }

  /** Plan, end date and state of each shop, for the admin shops list. */
  async briefsFor(
    db: Executor,
    tenantIds: string[],
    today = karachiDate(),
  ): Promise<Map<string, SubscriptionBrief>> {
    if (!tenantIds.length) return new Map();
    const rows = await db
      .selectDistinctOn([tenantSubscriptions.tenantId], {
        tenantId: tenantSubscriptions.tenantId,
        endsOn: tenantSubscriptions.endsOn,
        graceDays: tenantSubscriptions.graceDays,
        planName: plans.name,
      })
      .from(tenantSubscriptions)
      .innerJoin(plans, eq(plans.id, tenantSubscriptions.planId))
      .where(
        and(
          inArray(tenantSubscriptions.tenantId, tenantIds),
          ne(tenantSubscriptions.status, 'cancelled'),
        ),
      )
      .orderBy(
        tenantSubscriptions.tenantId,
        desc(tenantSubscriptions.endsOn),
        desc(tenantSubscriptions.createdAt),
      );
    return new Map(
      rows.map((r) => {
        const access = accessFor(r, today);
        return [
          r.tenantId,
          {
            planName: r.planName,
            endsOn: r.endsOn,
            state: access.state,
            daysLeft: access.daysLeft,
          },
        ];
      }),
    );
  }

  /**
   * Puts a shop on a plan for a period. The shop's running subscription is
   * cancelled (replaced); access follows the new dates at once.
   */
  assign(
    tenantId: string,
    input: AssignSubscriptionInput,
    today = karachiDate(),
  ): Promise<SubscriptionView> {
    return this.platform.transaction(async ({ tx, audit }) => {
      await this.lockShop(tx, tenantId);
      const [plan] = await tx
        .select()
        .from(plans)
        .where(eq(plans.id, input.planId))
        .limit(1);
      if (!plan) throw fieldError('planId', 'Plan not found');
      if (!plan.isActive) throw planInactive();

      const startsOn = input.startsOn ?? today;
      if (input.endsOn < startsOn) {
        throw fieldError(
          'endsOn',
          'The end date must be on or after the start date',
        );
      }
      if (input.endsOn < today) {
        throw fieldError('endsOn', 'The end date must be today or later');
      }

      const replaced = await tx
        .update(tenantSubscriptions)
        .set({ status: 'cancelled' })
        .where(
          and(
            eq(tenantSubscriptions.tenantId, tenantId),
            eq(tenantSubscriptions.status, 'active'),
          ),
        )
        .returning({ id: tenantSubscriptions.id });
      for (const { id } of replaced) {
        await audit({
          tenantId,
          entity: 'tenant_subscriptions',
          entityId: id,
          action: 'update',
          before: { status: 'active' },
          after: { status: 'cancelled' },
        });
      }

      const [row] = await tx
        .insert(tenantSubscriptions)
        .values({
          tenantId,
          planId: plan.id,
          startsOn,
          endsOn: input.endsOn,
          graceDays: input.graceDays,
          status: 'active',
        })
        .returning();
      await audit({
        tenantId,
        entity: 'tenant_subscriptions',
        entityId: row.id,
        action: 'create',
        after: row,
      });
      return (await this.viewFor(tx, tenantId, today))!;
    });
  }

  /** Moves the current subscription's end date later; full access at once. */
  extend(
    tenantId: string,
    input: ExtendSubscriptionInput,
    today = karachiDate(),
  ): Promise<SubscriptionView> {
    return this.platform.transaction(async ({ tx, audit }) => {
      await this.lockShop(tx, tenantId);
      const current = await currentSubscription(tx, tenantId);
      if (!current) throw noSubscription();
      const before = current.subscription;
      if (input.endsOn <= before.endsOn) {
        throw fieldError('endsOn', 'Pick a date after the current end date');
      }
      if (input.endsOn < today) {
        throw fieldError('endsOn', 'The end date must be today or later');
      }
      await tx
        .update(tenantSubscriptions)
        .set({ endsOn: input.endsOn, status: 'active' })
        .where(eq(tenantSubscriptions.id, before.id));
      await audit({
        tenantId,
        entity: 'tenant_subscriptions',
        entityId: before.id,
        action: 'update',
        before: { endsOn: before.endsOn, status: before.status },
        after: { endsOn: input.endsOn, status: 'active' },
      });
      return (await this.viewFor(tx, tenantId, today))!;
    });
  }

  /** 404 for an unknown shop; serialises plan changes of one shop. */
  private async lockShop(db: Executor, tenantId: string): Promise<void> {
    const [shop] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.id, tenantId), isNull(tenants.deletedAt)))
      .for('update')
      .limit(1);
    if (!shop) throw new NotFoundException('Shop not found');
  }
}
