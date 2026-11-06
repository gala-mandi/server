import { Injectable, NotFoundException } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  type SQL,
  sql,
} from 'drizzle-orm';
import { diffChanges } from '../../database/audit/audit-diff';
import {
  PlatformDatabase,
  type PlatformScope,
} from '../../database/platform-database';
import { plans, tenantSubscriptions } from '../../database/schema';
import { TRIAL_PLAN_NAME } from './access-state';
import type {
  CreatePlanInput,
  ListPlansQuery,
  Plan,
  UpdatePlanInput,
} from './plans.dto';
import { planNameTaken, trialPlanLocked } from './subscription-errors';
import type { PlanRow } from './subscription-queries';

type Tx = PlatformScope['tx'];

export function toPlan(row: PlanRow, shopCount = 0): Plan {
  return {
    id: row.id,
    name: row.name,
    maxUsers: row.maxUsers,
    maxBranches: row.maxBranches,
    priceMonthly: row.priceMonthly,
    isActive: row.isActive,
    isTrial: row.name === TRIAL_PLAN_NAME,
    shopCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Super-admin management of plans. Every write is audited. */
@Injectable()
export class PlansService {
  constructor(private readonly platform: PlatformDatabase) {}

  list(query: ListPlansQuery) {
    return this.platform.transaction(async ({ tx }) => {
      const filters: SQL[] = [];
      if (query.search) {
        filters.push(
          ilike(plans.name, `%${query.search.replace(/[%_\\]/g, '\\$&')}%`),
        );
      }
      if (query.isActive !== undefined) {
        filters.push(eq(plans.isActive, query.isActive));
      }
      const where = filters.length ? and(...filters) : undefined;
      const order = {
        priceMonthly: asc(plans.priceMonthly),
        '-priceMonthly': desc(plans.priceMonthly),
        name: asc(plans.name),
        '-name': desc(plans.name),
        createdAt: asc(plans.createdAt),
        '-createdAt': desc(plans.createdAt),
      }[query.sort];

      const [rows, [{ total }]] = await Promise.all([
        tx
          .select()
          .from(plans)
          .where(where)
          .orderBy(order, asc(plans.name))
          .limit(query.limit)
          .offset((query.page - 1) * query.limit),
        tx.select({ total: count() }).from(plans).where(where),
      ]);
      const counts = await this.shopCounts(
        tx,
        rows.map((r) => r.id),
      );
      return {
        data: rows.map((row) => toPlan(row, counts.get(row.id) ?? 0)),
        meta: { page: query.page, limit: query.limit, total },
      };
    });
  }

  get(id: string): Promise<Plan> {
    return this.platform.transaction(({ tx }) => this.view(tx, id));
  }

  create(input: CreatePlanInput): Promise<Plan> {
    return this.platform.transaction(async ({ tx, audit }) => {
      await this.assertNameFree(tx, input.name);
      const [row] = await tx
        .insert(plans)
        .values(input)
        .returning()
        .catch(rethrowNameTaken);
      await audit({
        tenantId: null,
        entity: 'plans',
        entityId: row.id,
        action: 'create',
        after: row,
      });
      return toPlan(row);
    });
  }

  update(id: string, input: UpdatePlanInput): Promise<Plan> {
    return this.platform.transaction(async ({ tx, audit }) => {
      const before = await this.row(tx, id);
      if (before.name === TRIAL_PLAN_NAME) {
        const renamed =
          input.name !== undefined && input.name !== TRIAL_PLAN_NAME;
        if (renamed || input.isActive === false) throw trialPlanLocked();
      }
      if (input.name !== undefined && input.name !== before.name) {
        await this.assertNameFree(tx, input.name, id);
      }
      if (Object.keys(input).length) {
        const [after] = await tx
          .update(plans)
          .set(input)
          .where(eq(plans.id, id))
          .returning()
          .catch(rethrowNameTaken);
        const changes = diffChanges(before, after);
        if (changes) {
          await audit({
            tenantId: null,
            entity: 'plans',
            entityId: id,
            action: 'update',
            ...changes,
          });
        }
      }
      return this.view(tx, id);
    });
  }

  /**
   * Deletes a plan no subscription ever used; a plan shops have used is
   * deactivated instead, so their history keeps it.
   */
  remove(
    id: string,
  ): Promise<{ result: 'deleted' | 'deactivated'; plan: Plan }> {
    return this.platform.transaction(async ({ tx, audit }) => {
      const before = await this.row(tx, id);
      if (before.name === TRIAL_PLAN_NAME) throw trialPlanLocked();

      const [used] = await tx
        .select({ id: tenantSubscriptions.id })
        .from(tenantSubscriptions)
        .where(eq(tenantSubscriptions.planId, id))
        .limit(1);
      if (!used) {
        await tx.delete(plans).where(eq(plans.id, id));
        await audit({
          tenantId: null,
          entity: 'plans',
          entityId: id,
          action: 'delete',
          before,
        });
        return { result: 'deleted' as const, plan: toPlan(before) };
      }

      if (before.isActive) {
        await tx.update(plans).set({ isActive: false }).where(eq(plans.id, id));
        await audit({
          tenantId: null,
          entity: 'plans',
          entityId: id,
          action: 'update',
          before: { isActive: true },
          after: { isActive: false },
        });
      }
      return { result: 'deactivated' as const, plan: await this.view(tx, id) };
    });
  }

  private async view(tx: Tx, id: string): Promise<Plan> {
    const row = await this.row(tx, id);
    const counts = await this.shopCounts(tx, [id]);
    return toPlan(row, counts.get(id) ?? 0);
  }

  private async row(tx: Tx, id: string): Promise<PlanRow> {
    const [row] = await tx
      .select()
      .from(plans)
      .where(eq(plans.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Plan not found');
    return row;
  }

  /** Names are unique ignoring case ("pro" and "Pro" would confuse). */
  private async assertNameFree(
    tx: Tx,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const [taken] = await tx
      .select({ id: plans.id })
      .from(plans)
      .where(eq(sql`lower(${plans.name})`, name.toLowerCase()))
      .limit(1);
    if (taken && taken.id !== exceptId) throw planNameTaken();
  }

  /** Shops whose current (latest, not cancelled) subscription is the plan. */
  private async shopCounts(
    tx: Tx,
    ids: string[],
  ): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const current = tx
      .selectDistinctOn([tenantSubscriptions.tenantId], {
        tenantId: tenantSubscriptions.tenantId,
        planId: tenantSubscriptions.planId,
      })
      .from(tenantSubscriptions)
      .where(sql`${tenantSubscriptions.status} <> 'cancelled'`)
      .orderBy(
        tenantSubscriptions.tenantId,
        desc(tenantSubscriptions.endsOn),
        desc(tenantSubscriptions.createdAt),
      )
      .as('current');
    const rows = await tx
      .select({ planId: current.planId, n: count() })
      .from(current)
      .where(inArray(current.planId, ids))
      .groupBy(current.planId);
    return new Map(rows.map((r) => [r.planId, r.n]));
  }
}

function rethrowNameTaken(error: unknown): never {
  for (const e of [error, (error as { cause?: unknown })?.cause]) {
    if ((e as { code?: unknown } | null)?.code === '23505') {
      throw planNameTaken();
    }
  }
  throw error;
}
