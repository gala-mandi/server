import { getTableName, type InferSelectModel } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { auditLogs } from '../schema';
import type { TenantTable } from '../tenant-table';
import {
  type TenantInsert,
  tenantScoped,
  type TenantUpdate,
} from '../tenant-scoped';
import { diffChanges, maskSensitive } from './audit-diff';

type Tx = PgTransaction<any, any, any>;

export type AuditAction = 'create' | 'update' | 'delete' | 'restore';

/** Who did it; filled from the request context. */
export interface AuditActor {
  userId: string | null;
  ip: string | null;
  userAgent: string | null;
}

type Row<T extends TenantTable> = InferSelectModel<T> & { id: string };

/**
 * `tenantScoped()` whose writes also write `audit_logs` in the same
 * transaction: if the audit row fails, the change is rolled back too.
 * Reads are the plain scoped reads (soft-deleted rows excluded).
 */
export function auditedScoped<T extends TenantTable>(
  tx: Tx,
  table: T,
  tenantId: string,
  actor: AuditActor,
) {
  const base = tenantScoped(tx, table, tenantId);
  const entity = getTableName(table);

  const log = async (
    action: AuditAction,
    entityId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> => {
    await tx.insert(auditLogs).values({
      tenantId,
      userId: actor.userId,
      entity,
      entityId,
      action,
      before: before === null ? null : maskSensitive(before),
      after: after === null ? null : maskSensitive(after),
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  };

  return {
    ...base,

    insert: async (
      values: TenantInsert<T> | TenantInsert<T>[],
    ): Promise<Row<T>[]> => {
      const rows = (await base.insert(values)) as unknown as Row<T>[];
      for (const row of rows) await log('create', row.id, null, row);
      return rows;
    },

    /** Returns the updated row, or null if it isn't in this shop. */
    update: async (
      id: string,
      values: TenantUpdate<T>,
    ): Promise<Row<T> | null> => {
      const before = (await base.findById(id)) as unknown as Row<T> | null;
      if (!before) return null;
      const [after] = (await base.update(id, values)) as unknown as Row<T>[];
      // Deleted by another request in between: same as not found.
      if (!after) return null;
      const changes = diffChanges(before, after);
      // Only changed fields are kept, e.g. { weight: 400 } → { weight: 420 }.
      if (changes) await log('update', id, changes.before, changes.after);
      return after;
    },

    /** Hides the row (sets `deleted_at`). Returns false if not found. */
    softDelete: async (id: string): Promise<boolean> => {
      const before = await base.findById(id);
      if (!before) return false;
      await base.softDelete(id);
      await log('delete', id, before, null);
      return true;
    },

    /** Brings a soft-deleted row back. Returns null if there is none. */
    restore: async (id: string): Promise<Row<T> | null> => {
      const [row] = (await base.restore(id)) as unknown as Row<T>[];
      if (!row) return null;
      await log('restore', id, null, row);
      return row;
    },
  };
}

export type AuditedScoped<T extends TenantTable> = ReturnType<
  typeof auditedScoped<T>
>;
