import { ConflictException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { paymentAllocations, payments } from '../../database/schema';
import type { TenantScope } from '../../database/tenant-database';

/** A purchase (settled by payments) or a sale (settled by receipts). */
export type BillKind = 'purchase' | 'sale';

const billColumn = (kind: BillKind) =>
  kind === 'purchase'
    ? paymentAllocations.purchaseId
    : paymentAllocations.saleId;

/** Allocations that count: not deleted, of a posted payment. */
const live = and(
  isNull(paymentAllocations.deletedAt),
  isNull(payments.deletedAt),
  eq(payments.status, 'posted'),
);

/**
 * Rupees settled on a bill by live allocations, as a correlated subquery for
 * the bill lists (`billId` / `tenantId` are the bill table's columns).
 */
export function allocatedSql(
  kind: BillKind,
  billId: AnyPgColumn,
  tenantId: AnyPgColumn,
): SQL<string> {
  return sql<string>`(select coalesce(sum(${paymentAllocations.amount}), 0)::numeric(14,2)::text
      from ${paymentAllocations}
      join ${payments}
        on ${payments.id} = ${paymentAllocations.paymentId}
       and ${payments.tenantId} = ${paymentAllocations.tenantId}
     where ${paymentAllocations.tenantId} = ${tenantId}
       and ${billColumn(kind)} = ${billId}
       and ${live})`;
}

export interface BillAllocations {
  /** Rupees, 2 decimals. */
  total: string;
  /** Voucher numbers of the payments, oldest first. */
  vouchers: string[];
}

/**
 * Live allocations of some bills, by bill id (bills without any are left
 * out). Run it after locking the bills: a new statement sees what other
 * saves committed while this one waited.
 */
export async function allocationsOf(
  { tx, tenantId }: Pick<TenantScope, 'tx' | 'tenantId'>,
  kind: BillKind,
  billIds: readonly string[],
): Promise<Map<string, BillAllocations>> {
  const result = new Map<string, BillAllocations>();
  if (!billIds.length) return result;
  const column = billColumn(kind);
  const rows = await tx
    .select({
      billId: column,
      amount: paymentAllocations.amount,
      voucherNo: payments.voucherNo,
    })
    .from(paymentAllocations)
    .innerJoin(
      payments,
      and(
        eq(payments.id, paymentAllocations.paymentId),
        eq(payments.tenantId, paymentAllocations.tenantId),
      ),
    )
    .where(
      and(
        eq(paymentAllocations.tenantId, tenantId),
        inArray(column, [...billIds]),
        live,
      ),
    )
    .orderBy(asc(payments.createdAt), asc(payments.id));
  for (const row of rows) {
    const id = row.billId!;
    const entry = result.get(id) ?? { total: '0.00', vouchers: [] };
    entry.total = new Decimal(entry.total).plus(row.amount).toFixed(2);
    if (!entry.vouchers.includes(row.voucherNo)) {
      entry.vouchers.push(row.voucherNo);
    }
    result.set(id, entry);
  }
  return result;
}

/** Live allocations of one bill (0 and none when it has none). */
export async function allocationsOfBill(
  scope: Pick<TenantScope, 'tx' | 'tenantId'>,
  kind: BillKind,
  billId: string,
): Promise<BillAllocations> {
  return (
    (await allocationsOf(scope, kind, [billId])).get(billId) ?? {
      total: '0.00',
      vouchers: [],
    }
  );
}

export const BILL_HAS_PAYMENTS = 'BILL_HAS_PAYMENTS';

/**
 * 409 for a bill change that the payments against it don't allow (cancel,
 * another trader, a net below what is already settled).
 */
export function billHasPayments(
  { total, vouchers }: BillAllocations,
  what: string,
): ConflictException {
  return new ConflictException({
    message: `${vouchers.join(', ')} settled Rs ${total} of this bill, so it cannot ${what}. Cancel ${vouchers.length > 1 ? 'those vouchers' : 'that voucher'} first.`,
    code: BILL_HAS_PAYMENTS,
  });
}
