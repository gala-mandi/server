import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { auditLogs, tenants, users } from '../../database/schema';
import { PlatformDatabase } from '../../database/platform-database';
import {
  type ActivityFeed,
  type ActivityQuery,
  INACTIVE_DAYS,
  type InactiveShopPage,
  type InactiveShopsQuery,
  type NewShops,
  type NewShopsQuery,
  type PlatformStats,
} from './stats.dto';

const TZ = 'Asia/Karachi';

type ShopStatus = (typeof tenants.$inferSelect)['status'];

interface IdleShopRow {
  id: string;
  name: string;
  city: string | null;
  status: 'trial' | 'active';
  last_activity_at: Date | string;
}

/** `tx.execute()` result rows (node-postgres). */
function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

/**
 * Platform-wide counts for the super-admin dashboard. Read-only, so nothing
 * is audited (like the shop list); never reads a business table or the
 * before/after values of an audit row.
 */
@Injectable()
export class StatsService {
  constructor(private readonly platform: PlatformDatabase) {}

  summary(): Promise<PlatformStats> {
    return this.platform.transaction(async ({ tx }) => {
      const [byStatus, [people]] = await Promise.all([
        tx
          .select({ status: tenants.status, n: count() })
          .from(tenants)
          .where(isNull(tenants.deletedAt))
          .groupBy(tenants.status),
        tx
          .select({
            total: count(),
            active: sql<number>`(count(*) filter (where ${users.isActive}
              and ${tenants.status} in ('trial', 'active')))::int`,
          })
          .from(users)
          // Inner join: the platform admin has no shop and is left out.
          .innerJoin(tenants, eq(tenants.id, users.tenantId))
          .where(and(isNull(users.deletedAt), isNull(tenants.deletedAt))),
      ]);

      const shops: Record<ShopStatus, number> = {
        trial: 0,
        active: 0,
        suspended: 0,
        cancelled: 0,
      };
      for (const row of byStatus) shops[row.status] = row.n;
      const total = Object.values(shops).reduce((a, b) => a + b, 0);

      return {
        shops: { total, ...shops },
        users: { total: people.total, active: people.active },
      };
    });
  }

  /** Shops created per Asia/Karachi calendar month; empty months are 0. */
  newShops(query: NewShopsQuery): Promise<NewShops> {
    return this.platform.transaction(async ({ tx }) => {
      const result: unknown = await tx.execute(sql`
        with months as (
          select generate_series(
            date_trunc('month', now() at time zone ${TZ})
              - make_interval(months => ${query.months - 1}),
            date_trunc('month', now() at time zone ${TZ}),
            interval '1 month'
          ) as month
        )
        select to_char(m.month, 'YYYY-MM') as month, count(t.id)::int as count
        from months m
        left join ${tenants} t
          on t.deleted_at is null
          and t.created_at >= m.month at time zone ${TZ}
          and t.created_at < (m.month + interval '1 month') at time zone ${TZ}
        group by m.month
        order by m.month
      `);
      const rows = rowsOf<{ month: string; count: number }>(result);
      return { data: rows.map((r) => ({ month: r.month, count: r.count })) };
    });
  }

  /** Latest audit rows across all shops, newest first, without their values. */
  activity(query: ActivityQuery): Promise<ActivityFeed> {
    return this.platform.transaction(async ({ tx }) => {
      const rows = await tx
        .select({
          id: auditLogs.id,
          tenantId: auditLogs.tenantId,
          tenantName: tenants.name,
          userId: auditLogs.userId,
          userName: users.name,
          userRole: users.role,
          entity: auditLogs.entity,
          entityId: auditLogs.entityId,
          action: auditLogs.action,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .leftJoin(tenants, eq(tenants.id, auditLogs.tenantId))
        .leftJoin(users, eq(users.id, auditLogs.userId))
        // The id follows insert order and has an index; created_at across
        // all shops has none.
        .orderBy(desc(auditLogs.id))
        .limit(query.limit);

      return {
        data: rows.map((row) => ({
          id: row.id,
          tenant:
            row.tenantId && row.tenantName !== null
              ? { id: row.tenantId, name: row.tenantName }
              : null,
          user:
            row.userId && row.userName !== null && row.userRole !== null
              ? { id: row.userId, name: row.userName, role: row.userRole }
              : null,
          entity: row.entity,
          entityId: row.entityId,
          action: row.action,
          createdAt: row.createdAt.toISOString(),
        })),
      };
    });
  }

  /**
   * Trial and active shops where nobody of the shop has changed anything or
   * signed in for INACTIVE_DAYS (a new shop counts from its creation). The
   * platform admin's own actions on a shop don't count. Longest idle first.
   */
  inactiveShops(query: InactiveShopsQuery): Promise<InactiveShopPage> {
    return this.platform.transaction(async ({ tx }) => {
      const idle = sql`
        select t.id, t.name, t.city, t.status,
          greatest(
            t.created_at,
            (select max(a.created_at) from ${auditLogs} a
              join ${users} su on su.id = a.user_id and su.tenant_id = t.id
              where a.tenant_id = t.id),
            (select max(u.last_login_at) from ${users} u
              where u.tenant_id = t.id)
          ) as last_activity_at
        from ${tenants} t
        where t.deleted_at is null and t.status in ('trial', 'active')
      `;
      const cutoff = sql`now() - make_interval(days => ${INACTIVE_DAYS})`;

      const [page, counted] = await Promise.all<unknown>([
        tx.execute(sql`
          select * from (${idle}) s
          where s.last_activity_at < ${cutoff}
          order by s.last_activity_at, s.id
          limit ${query.limit} offset ${(query.page - 1) * query.limit}
        `),
        tx.execute(sql`
          select count(*)::int as total from (${idle}) s
          where s.last_activity_at < ${cutoff}
        `),
      ]);
      const rows = rowsOf<IdleShopRow>(page);
      const [{ total }] = rowsOf<{ total: number }>(counted);

      return {
        data: rows.map((row) => ({
          id: row.id,
          name: row.name,
          city: row.city,
          status: row.status,
          lastActivityAt: new Date(row.last_activity_at).toISOString(),
        })),
        meta: {
          page: query.page,
          limit: query.limit,
          total,
        },
      };
    });
  }
}
