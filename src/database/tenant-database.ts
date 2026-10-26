import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../common/context/request-context';
import { DRIZZLE, type Database } from './database.tokens';
import { auditLogs, tenants } from './schema';
import type { TenantTable } from './tenant-table';
import { tenantScoped } from './tenant-scoped';

type Tx = PgTransaction<any, any, any>;

/** What a tenant transaction callback receives. */
export interface TenantScope {
  tx: Tx;
  tenantId: string;
  /** Scoped helper for one business table; see `tenantScoped()`. */
  scoped: <T extends TenantTable>(
    table: T,
  ) => ReturnType<typeof tenantScoped<T>>;
}

/**
 * The only way services touch business tables. Each call runs in one
 * transaction that switches to the `app_tenant` role and sets
 * `app.tenant_id`, so Row-Level Security limits every query — even a raw one —
 * to that shop.
 */
@Injectable()
export class TenantDatabase {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  /** The shop of the current request, from the access token. */
  get tenantId(): string {
    const tenantId = this.cls.isActive() ? this.cls.get('tenantId') : null;
    if (!tenantId) throw new ForbiddenException('No shop selected');
    return tenantId;
  }

  /** Runs `fn` inside the current request's shop. */
  transaction<R>(fn: (scope: TenantScope) => Promise<R>): Promise<R> {
    return this.run(this.tenantId, fn);
  }

  /**
   * Super-admin only: runs `fn` inside another shop. Every call is written to
   * `audit_logs` before anything else happens.
   */
  async withTenant<R>(
    tenantId: string,
    fn: (scope: TenantScope) => Promise<R>,
  ): Promise<R> {
    if (this.cls.get('role') !== 'super_admin') {
      throw new ForbiddenException('Only the platform admin can open a shop');
    }
    const [tenant] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundException('Shop not found');

    await this.db.insert(auditLogs).values({
      tenantId,
      userId: this.cls.get('userId') ?? null,
      entity: 'tenant',
      entityId: tenantId,
      action: 'access',
      ip: this.cls.get('ip') ?? null,
    });
    return this.run(tenantId, fn);
  }

  private run<R>(
    tenantId: string,
    fn: (scope: TenantScope) => Promise<R>,
  ): Promise<R> {
    return this.db.transaction(async (tx) => {
      // LOCAL: both reset when the transaction ends, so pooled connections
      // never carry one shop's setting into another request.
      await tx.execute(sql`set local role app_tenant`);
      await tx.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true)`,
      );
      return fn({
        tx,
        tenantId,
        scoped: (table) => tenantScoped(tx, table, tenantId),
      });
    });
  }
}
