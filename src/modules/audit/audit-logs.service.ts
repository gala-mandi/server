import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, lt, type SQL } from 'drizzle-orm';
import { auditLogs } from '../../database/schema';
import {
  TenantDatabase,
  type TenantScope,
} from '../../database/tenant-database';
import type { AuditLogPageDto, AuditLogQuery } from './audit-logs.dto';

@Injectable()
export class AuditLogsService {
  constructor(private readonly tenantDb: TenantDatabase) {}

  /** The current shop's log (owner). */
  list(query: AuditLogQuery): Promise<AuditLogPageDto> {
    return this.tenantDb.transaction((scope) => this.page(scope, query));
  }

  /** Any shop's log (super-admin); the access itself is audited. */
  listForTenant(
    tenantId: string,
    query: AuditLogQuery,
  ): Promise<AuditLogPageDto> {
    return this.tenantDb.withTenant(tenantId, (scope) =>
      this.page(scope, query),
    );
  }

  private async page(
    { tx, tenantId }: TenantScope,
    query: AuditLogQuery,
  ): Promise<AuditLogPageDto> {
    // audit_logs has no RLS (platform rows have no shop), so the shop filter
    // is written out here and always comes first.
    const filters: SQL[] = [eq(auditLogs.tenantId, tenantId)];
    if (query.userId) filters.push(eq(auditLogs.userId, query.userId));
    if (query.entity) filters.push(eq(auditLogs.entity, query.entity));
    if (query.entityId) filters.push(eq(auditLogs.entityId, query.entityId));
    if (query.action) filters.push(eq(auditLogs.action, query.action));
    if (query.from) filters.push(gte(auditLogs.createdAt, query.from));
    if (query.to) filters.push(lt(auditLogs.createdAt, query.to));
    const where = and(...filters);

    const [rows, [{ total }]] = await Promise.all([
      tx
        .select({
          id: auditLogs.id,
          userId: auditLogs.userId,
          entity: auditLogs.entity,
          entityId: auditLogs.entityId,
          action: auditLogs.action,
          before: auditLogs.before,
          after: auditLogs.after,
          ip: auditLogs.ip,
          userAgent: auditLogs.userAgent,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(where)
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
      tx.select({ total: count() }).from(auditLogs).where(where),
    ]);

    const data = rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }));
    return { data, meta: { page: query.page, limit: query.limit, total } };
  }
}
