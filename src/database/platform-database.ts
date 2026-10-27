import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../common/context/request-context';
import { maskSensitive } from './audit/audit-diff';
import type { AuditAction } from './audit/audited-scoped';
import { DRIZZLE, type Database } from './database.tokens';
import { auditLogs } from './schema';

type Tx = PgTransaction<any, any, any>;

export interface AuditEntry {
  tenantId: string | null;
  entity: string;
  entityId: string;
  action: AuditAction;
  before?: unknown;
  after?: unknown;
}

export interface PlatformScope {
  tx: Tx;
  /** Writes one `audit_logs` row in the same transaction (values masked). */
  audit: (entry: AuditEntry) => Promise<void>;
}

/**
 * Platform-level work across shops (creating, suspending, activating shops).
 * Super-admin only. Runs as the API's own DB role, so RLS does not apply:
 * every query must say which shop it touches, and every write must be
 * audited through `audit()`.
 */
@Injectable()
export class PlatformDatabase {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  transaction<R>(fn: (scope: PlatformScope) => Promise<R>): Promise<R> {
    if (!this.cls.isActive() || this.cls.get('role') !== 'super_admin') {
      throw new ForbiddenException('Only the platform admin can do this');
    }
    const actor = {
      userId: this.cls.get('userId') ?? null,
      ip: this.cls.get('ip') ?? null,
      userAgent: this.cls.get('userAgent') ?? null,
    };

    return this.db.transaction((tx) =>
      fn({
        tx,
        audit: async ({
          tenantId,
          entity,
          entityId,
          action,
          before,
          after,
        }) => {
          await tx.insert(auditLogs).values({
            tenantId,
            userId: actor.userId,
            entity,
            entityId,
            action,
            before: before === undefined ? null : maskSensitive(before),
            after: after === undefined ? null : maskSensitive(after),
            ip: actor.ip,
            userAgent: actor.userAgent,
          });
        },
      }),
    );
  }
}
