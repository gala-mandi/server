import {
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenantColumns, tenantIsolation } from '../tenant-table';
import { commodities } from './commodities';
import { docStatus, purchaseItems } from './purchases';
import { traders } from './traders';

/**
 * Goods sold to a beopari: one parchi. Totals are stored as saved, so later
 * setting changes never alter it; a cancelled sale keeps its row and bill
 * number. `net_amount − (gross_amount + total_charges)` is the rounding of
 * the net to whole rupees.
 */
export const sales = pgTable(
  'sales',
  {
    ...tenantColumns(),
    // e.g. SAL-2026-27-000123, from number_sequences.
    billNo: varchar('bill_no', { length: 30 }).notNull(),
    // The beopari (buyer).
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => traders.id),
    // 'YYYY-MM-DD' in Asia/Karachi.
    saleDate: date('sale_date', { mode: 'string' }).notNull(),
    grossAmount: numeric('gross_amount', { precision: 14, scale: 2 }).notNull(),
    totalCharges: numeric('total_charges', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    netAmount: numeric('net_amount', { precision: 14, scale: 2 }).notNull(),
    // Received from the beopari on the same save.
    receivedAmount: numeric('received_amount', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    status: docStatus('status').notNull().default('posted'),
    notes: text('notes'),
    // The client's Idempotency-Key header of the save that created it.
    idempotencyKey: varchar('idempotency_key', { length: 64 }),
  },
  (t) => [
    uniqueIndex('sales_tenant_id_bill_no_key').on(t.tenantId, t.billNo),
    index('sales_tenant_id_sale_date_idx').on(t.tenantId, t.saleDate),
    index('sales_tenant_id_buyer_id_idx').on(t.tenantId, t.buyerId),
    // NULL keys never collide.
    uniqueIndex('sales_tenant_id_idempotency_key_key').on(
      t.tenantId,
      t.idempotencyKey,
    ),
    tenantIsolation(),
  ],
);

/** One commodity line of a sale; rate and amount copied at save time. */
export const saleItems = pgTable(
  'sale_items',
  {
    ...tenantColumns(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id),
    commodityId: uuid('commodity_id')
      .notNull()
      .references(() => commodities.id),
    // Optional: which kissan's lot was sold (commission-agent flow).
    purchaseItemId: uuid('purchase_item_id').references(() => purchaseItems.id),
    bags: integer('bags'),
    weightKg: numeric('weight_kg', { precision: 12, scale: 3 }).notNull(),
    rate: numeric('rate', { precision: 14, scale: 2 }).notNull(),
    // kg | maund | bag
    rateUnit: varchar('rate_unit', { length: 10 }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    index('sale_items_tenant_id_sale_id_idx').on(t.tenantId, t.saleId),
    // The commodity filter, and "is this commodity in use".
    index('sale_items_tenant_id_commodity_id_idx').on(
      t.tenantId,
      t.commodityId,
    ),
    // Which sales a kissan's lot went into.
    index('sale_items_tenant_id_purchase_item_id_idx').on(
      t.tenantId,
      t.purchaseItemId,
    ),
    tenantIsolation(),
  ],
);

/** One charge line added to a sale, with its rate copied at save time. */
export const saleCharges = pgTable(
  'sale_charges',
  {
    ...tenantColumns(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id),
    // commission | market_fee | labour | other
    type: varchar('type', { length: 20 }).notNull(),
    // percent | per_bag | fixed
    basis: varchar('basis', { length: 10 }).notNull(),
    value: numeric('value', { precision: 14, scale: 2 }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    index('sale_charges_tenant_id_sale_id_idx').on(t.tenantId, t.saleId),
    tenantIsolation(),
  ],
);
