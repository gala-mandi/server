import {
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenantColumns, tenantIsolation } from '../tenant-table';
import { commodities } from './commodities';
import { traders } from './traders';

/** Status of a purchase or sale (`doc_status` in the design). */
export const docStatus = pgEnum('doc_status', ['draft', 'posted', 'cancelled']);

/**
 * Goods bought from a kissan: one parchi. Totals are stored as saved, so
 * later setting changes never alter it; a cancelled purchase keeps its row and
 * bill number. `net_amount − (gross_amount − total_deductions)` is the
 * rounding of the net to whole rupees.
 */
export const purchases = pgTable(
  'purchases',
  {
    ...tenantColumns(),
    // e.g. PUR-2026-27-000123, from number_sequences.
    billNo: varchar('bill_no', { length: 30 }).notNull(),
    // The kissan (seller).
    traderId: uuid('trader_id')
      .notNull()
      .references(() => traders.id),
    // 'YYYY-MM-DD' in Asia/Karachi.
    purchaseDate: date('purchase_date', { mode: 'string' }).notNull(),
    grossAmount: numeric('gross_amount', { precision: 14, scale: 2 }).notNull(),
    totalDeductions: numeric('total_deductions', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    netAmount: numeric('net_amount', { precision: 14, scale: 2 }).notNull(),
    // Paid to the kissan on the same save.
    paidAmount: numeric('paid_amount', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    status: docStatus('status').notNull().default('posted'),
    notes: text('notes'),
    // The client's Idempotency-Key header of the save that created it.
    idempotencyKey: varchar('idempotency_key', { length: 64 }),
  },
  (t) => [
    uniqueIndex('purchases_tenant_id_bill_no_key').on(t.tenantId, t.billNo),
    index('purchases_tenant_id_purchase_date_idx').on(
      t.tenantId,
      t.purchaseDate,
    ),
    index('purchases_tenant_id_trader_id_idx').on(t.tenantId, t.traderId),
    // NULL keys never collide.
    uniqueIndex('purchases_tenant_id_idempotency_key_key').on(
      t.tenantId,
      t.idempotencyKey,
    ),
    tenantIsolation(),
  ],
);

/** One commodity line of a purchase; rate and amount copied at save time. */
export const purchaseItems = pgTable(
  'purchase_items',
  {
    ...tenantColumns(),
    purchaseId: uuid('purchase_id')
      .notNull()
      .references(() => purchases.id),
    commodityId: uuid('commodity_id')
      .notNull()
      .references(() => commodities.id),
    bags: integer('bags'),
    weightKg: numeric('weight_kg', { precision: 12, scale: 3 }).notNull(),
    rate: numeric('rate', { precision: 14, scale: 2 }).notNull(),
    // kg | maund | bag
    rateUnit: varchar('rate_unit', { length: 10 }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    index('purchase_items_tenant_id_purchase_id_idx').on(
      t.tenantId,
      t.purchaseId,
    ),
    // The commodity filter, and "is this commodity in use".
    index('purchase_items_tenant_id_commodity_id_idx').on(
      t.tenantId,
      t.commodityId,
    ),
    tenantIsolation(),
  ],
);

/** One deduction line of a purchase, with its rate copied at save time. */
export const purchaseCharges = pgTable(
  'purchase_charges',
  {
    ...tenantColumns(),
    purchaseId: uuid('purchase_id')
      .notNull()
      .references(() => purchases.id),
    // commission | market_fee | labour | other
    type: varchar('type', { length: 20 }).notNull(),
    // percent | per_bag | fixed
    basis: varchar('basis', { length: 10 }).notNull(),
    value: numeric('value', { precision: 14, scale: 2 }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    index('purchase_charges_tenant_id_purchase_id_idx').on(
      t.tenantId,
      t.purchaseId,
    ),
    tenantIsolation(),
  ],
);
