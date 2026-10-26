/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion --
 * `.from(table as TenantTable)` is needed: without it TypeScript cannot match a
 * generic table against Drizzle's conditional `from()` type. */
import {
  and,
  eq,
  type InferSelectModel,
  isNull,
  type SQL,
  sql,
} from 'drizzle-orm';
import type {
  PgInsertValue,
  PgTransaction,
  PgUpdateSetSource,
} from 'drizzle-orm/pg-core';
import type { TenantTable } from './tenant-table';

// The transaction type is the same for every driver call we make.
type AnyTx = PgTransaction<any, any, any>;

/** Values a caller may write: never `id` or `tenantId`. */
export type TenantInsert<T extends TenantTable> = Omit<
  PgInsertValue<T>,
  'id' | 'tenantId'
>;
export type TenantUpdate<T extends TenantTable> = Omit<
  PgUpdateSetSource<T>,
  'id' | 'tenantId'
>;

function withoutTenantId<V extends object>(values: V): V {
  const copy = { ...values } as Record<string, unknown>;
  delete copy.id;
  delete copy.tenantId;
  delete copy.tenant_id;
  return copy as V;
}

/**
 * Query helper for one business table inside one shop. Every read filters on
 * `tenant_id` and skips soft-deleted rows; every insert sets `tenant_id` from
 * the request, overwriting whatever the caller passed.
 *
 * For lists with paging or sorting, build the query yourself on the concrete
 * table and pass `where()` / `byId()`: those carry the tenant filter.
 */
export function tenantScoped<T extends TenantTable>(
  tx: AnyTx,
  table: T,
  tenantId: string,
) {
  const where = (extra?: SQL): SQL =>
    and(eq(table.tenantId, tenantId), isNull(table.deletedAt), extra)!;

  return {
    tenantId,
    where,

    /** `WHERE` for one row of this shop, for queries written by hand. */
    byId: (id: string): SQL => where(eq(table.id, id)),

    findMany: (extra?: SQL): Promise<InferSelectModel<T>[]> =>
      tx
        .select()
        .from(table as TenantTable)
        .where(where(extra)) as unknown as Promise<InferSelectModel<T>[]>,

    findById: async (id: string): Promise<InferSelectModel<T> | null> => {
      const rows = (await tx
        .select()
        .from(table as TenantTable)
        .where(where(eq(table.id, id)))
        .limit(1)) as InferSelectModel<T>[];
      return rows[0] ?? null;
    },

    count: async (extra?: SQL): Promise<number> => {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(table as TenantTable)
        .where(where(extra));
      return row?.count ?? 0;
    },

    insert: (values: TenantInsert<T> | TenantInsert<T>[]) => {
      const rows = (Array.isArray(values) ? values : [values]).map((v) => ({
        ...withoutTenantId(v),
        tenantId,
      }));
      return tx
        .insert(table)
        .values(rows as PgInsertValue<T>[])
        .returning();
    },

    update: (id: string, values: TenantUpdate<T>) =>
      tx
        .update(table)
        .set(withoutTenantId(values) as PgUpdateSetSource<T>)
        .where(where(eq(table.id, id)))
        .returning(),

    softDelete: (id: string) =>
      tx
        .update(table)
        .set({ deletedAt: sql`now()` } as PgUpdateSetSource<T>)
        .where(where(eq(table.id, id)))
        .returning({ id: table.id }),
  };
}

export type TenantScoped<T extends TenantTable> = ReturnType<
  typeof tenantScoped<T>
>;
