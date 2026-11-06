import { and, count, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { karachiDate } from '../../common/time/karachi-date';
import {
  invitations,
  plans,
  tenantSubscriptions,
  users,
} from '../../database/schema';
import { hasUserSeat, TRIAL_PLAN_NAME, trialPeriod } from './access-state';
import { planUserLimit, trialPlanMissing } from './subscription-errors';

/** A transaction (tenant or platform) or the pool. */
type Executor = PgDatabase<any, any, any>;

export type SubscriptionRow = typeof tenantSubscriptions.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;

export interface CurrentSubscription {
  subscription: SubscriptionRow;
  plan: PlanRow;
}

/**
 * The shop's current subscription: the latest by `ends_on` that is not
 * cancelled (a newer row wins a tie).
 */
export async function currentSubscription(
  db: Executor,
  tenantId: string,
): Promise<CurrentSubscription | null> {
  const [row] = await db
    .select({ subscription: tenantSubscriptions, plan: plans })
    .from(tenantSubscriptions)
    .innerJoin(plans, eq(plans.id, tenantSubscriptions.planId))
    .where(
      and(
        eq(tenantSubscriptions.tenantId, tenantId),
        ne(tenantSubscriptions.status, 'cancelled'),
      ),
    )
    .orderBy(
      desc(tenantSubscriptions.endsOn),
      desc(tenantSubscriptions.createdAt),
    )
    .limit(1);
  return row ?? null;
}

/** Seats taken: active users plus invites still waiting to be accepted. */
export async function usersUsed(db: Executor, tenantId: string) {
  const [[{ active }], [{ pending }]] = await Promise.all([
    db
      .select({ active: count() })
      .from(users)
      .where(
        and(
          eq(users.tenantId, tenantId),
          eq(users.isActive, true),
          isNull(users.deletedAt),
        ),
      ),
    db
      .select({ pending: count() })
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          isNull(invitations.acceptedAt),
          isNull(invitations.cancelledAt),
          gt(invitations.expiresAt, sql`now()`),
        ),
      ),
  ]);
  return active + pending;
}

/**
 * Throws `PLAN_USER_LIMIT` when the shop's plan has no room for one more
 * user. Call inside the transaction that adds the user or invite; it holds a
 * per-shop lock until that transaction ends, so two invites at once can't
 * both take the last seat.
 */
export async function assertUserSeat(
  db: Executor,
  tenantId: string,
  error: (maxUsers: number) => Error = planUserLimit,
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`seats:${tenantId}`}))`,
  );
  const current = await currentSubscription(db, tenantId);
  const maxUsers = current?.plan.maxUsers ?? 0;
  if (!hasUserSeat(await usersUsed(db, tenantId), maxUsers)) {
    throw error(maxUsers);
  }
}

/** A new shop starts on the Trial plan (platform transaction). */
export async function startTrial(
  db: Executor,
  tenantId: string,
  today: string = karachiDate(),
): Promise<SubscriptionRow> {
  const [trial] = await db
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.name, TRIAL_PLAN_NAME), eq(plans.isActive, true)))
    .limit(1);
  if (!trial) throw trialPlanMissing();
  const [row] = await db
    .insert(tenantSubscriptions)
    .values({
      tenantId,
      planId: trial.id,
      ...trialPeriod(today),
      status: 'active',
    })
    .returning();
  return row;
}
