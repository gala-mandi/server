import {
  date,
  index,
  numeric,
  pgTable,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { tenantColumns, tenantIsolation } from '../tenant-table';
import { commodities } from './commodities';

/**
 * A shop's rate for one commodity on one day (Asia/Karachi date), per maund
 * or per kg. One row per shop, commodity and day: saving the day again
 * updates it.
 */
export const dailyRates = pgTable(
  'daily_rates',
  {
    ...tenantColumns(),
    commodityId: uuid('commodity_id')
      .notNull()
      .references(() => commodities.id),
    // 'YYYY-MM-DD' in Asia/Karachi, not UTC.
    rateDate: date('rate_date', { mode: 'string' }).notNull(),
    minRate: numeric('min_rate', { precision: 14, scale: 2 }).notNull(),
    maxRate: numeric('max_rate', { precision: 14, scale: 2 }).notNull(),
    avgRate: numeric('avg_rate', { precision: 14, scale: 2 }),
    // maund | kg
    rateUnit: varchar('rate_unit', { length: 10 }).notNull().default('maund'),
  },
  (t) => [
    uniqueIndex('daily_rates_tenant_id_commodity_id_rate_date_key').on(
      t.tenantId,
      t.commodityId,
      t.rateDate,
    ),
    // "Today" and date-range history across all commodities.
    index('daily_rates_tenant_id_rate_date_idx').on(t.tenantId, t.rateDate),
    tenantIsolation(),
  ],
);
