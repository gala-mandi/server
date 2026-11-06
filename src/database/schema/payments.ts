import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenantColumns, tenantIsolation } from '../tenant-table';
import { docStatus, purchases } from './purchases';
import { sales } from './sales';
import { traders } from './traders';

/**
 * Money paid to a kissan or received from a beopari, in cash or bank: one
 * voucher. The part of `amount` no `payment_allocations` row covers is an
 * advance (peshgi). A cancelled payment keeps its row and voucher number.
 */
export const payments = pgTable(
  'payments',
  {
    ...tenantColumns(),
    // e.g. PAY-2026-27-000123 (paid) or RCT-2026-27-000123 (received).
    voucherNo: varchar('voucher_no', { length: 30 }).notNull(),
    // paid (to kissan) | received (from beopari)
    direction: varchar('direction', { length: 10 }).notNull(),
    traderId: uuid('trader_id')
      .notNull()
      .references(() => traders.id),
    // 'YYYY-MM-DD' in Asia/Karachi.
    paymentDate: date('payment_date', { mode: 'string' }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    // cash | bank | cheque | online
    method: varchar('method', { length: 10 }).notNull(),
    // Cheque number, bank or transfer reference.
    reference: varchar('reference', { length: 80 }),
    notes: text('notes'),
    status: docStatus('status').notNull().default('posted'),
    // The client's Idempotency-Key header of the save that created it.
    idempotencyKey: varchar('idempotency_key', { length: 64 }),
  },
  (t) => [
    // Payments and receipts are two series (PAY, RCT); a shop's own bill
    // prefix gives both the same form, so the direction is in the key.
    uniqueIndex('payments_tenant_id_direction_voucher_no_key').on(
      t.tenantId,
      t.direction,
      t.voucherNo,
    ),
    index('payments_tenant_id_payment_date_idx').on(t.tenantId, t.paymentDate),
    index('payments_tenant_id_trader_id_idx').on(t.tenantId, t.traderId),
    // NULL keys never collide.
    uniqueIndex('payments_tenant_id_idempotency_key_key').on(
      t.tenantId,
      t.idempotencyKey,
    ),
    tenantIsolation(),
  ],
);

/**
 * The part of a payment that settles one bill: a purchase (money paid to the
 * kissan) or a sale (money received from the beopari), exactly one of them.
 * Rows of a cancelled payment stay as history and no longer count.
 */
export const paymentAllocations = pgTable(
  'payment_allocations',
  {
    ...tenantColumns(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    purchaseId: uuid('purchase_id').references(() => purchases.id),
    saleId: uuid('sale_id').references(() => sales.id),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    index('payment_allocations_tenant_id_payment_id_idx').on(
      t.tenantId,
      t.paymentId,
    ),
    // What is still to pay on a bill.
    index('payment_allocations_tenant_id_purchase_id_idx').on(
      t.tenantId,
      t.purchaseId,
    ),
    index('payment_allocations_tenant_id_sale_id_idx').on(t.tenantId, t.saleId),
    check(
      'payment_allocations_one_bill',
      sql`(${t.purchaseId} is null) <> (${t.saleId} is null)`,
    ),
    check('payment_allocations_amount_positive', sql`${t.amount} > 0`),
    tenantIsolation(),
  ],
);
