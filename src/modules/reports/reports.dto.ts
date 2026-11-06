import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isCalendarDate } from '../../common/time/karachi-date';
import { traderType } from '../../database/schema';
import { cashBookSchema, MAX_CASH_BOOK_DAYS } from '../payments/payments.dto';
import { rateSchema } from '../rates/rates.dto';

/**
 * Longest date range of one report request: a year, leap years included.
 * The same limit as the cash book, which the cash-book report reuses.
 */
export const MAX_REPORT_DAYS = MAX_CASH_BOOK_DAYS;

/** How the purchases and sales reports group their rows. */
export const REPORT_GROUPS = ['day', 'commodity', 'trader'] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

/** Most traders one side of the outstanding report may list. */
export const MAX_OUTSTANDING_LIMIT = 1000;

const day = z
  .string()
  .trim()
  .refine(isCalendarDate, 'Enter the date as YYYY-MM-DD');

/**
 * A date range. `to` defaults to today (Asia/Karachi) and `from` to `to`;
 * both are included. At most MAX_REPORT_DAYS days.
 */
export const reportRangeQuerySchema = z.object({
  from: day.optional(),
  to: day.optional(),
});

export const dailySummaryQuerySchema = z.object({
  /** Defaults to today (Asia/Karachi). */
  date: day.optional(),
});

export const bookReportQuerySchema = reportRangeQuerySchema.extend({
  groupBy: z
    .enum(REPORT_GROUPS, 'Group by day, commodity or trader')
    .default('day'),
  /** Only the lines of this commodity. */
  commodity: z.uuid('Choose a commodity').optional(),
  /** Only the bills of this kissan (purchases) or beopari (sales). */
  trader: z.uuid('Choose a trader').optional(),
});

export const outstandingQuerySchema = z.object({
  /** Balances at the end of this day; defaults to everything so far. */
  asOf: day.optional(),
  type: z.enum(traderType.enumValues).optional(),
  /** Largest N of each side; all traders when left out. */
  limit: z.coerce.number().int().min(1).max(MAX_OUTSTANDING_LIMIT).optional(),
});

export type ReportRangeQuery = z.infer<typeof reportRangeQuerySchema>;
export type DailySummaryQuery = z.infer<typeof dailySummaryQuerySchema>;
export type BookReportQuery = z.infer<typeof bookReportQuerySchema>;
export type OutstandingQuery = z.infer<typeof outstandingQuerySchema>;

/* ------------------------------------------------------------------ */

const rupees = z.string();
const count = z.number().int().min(0);

/** What every purchases or sales row and total carries. */
const lineMetrics = {
  /** Posted bills counted (a bill with two commodities counts in both rows). */
  bills: count,
  bags: count,
  /** kg, 3 decimals, e.g. "1000.000". */
  weightKg: z.string(),
  /** Sum of the item amounts, which is the bills' gross amount. */
  grossAmount: rupees,
};

export const purchaseMetricsSchema = z.object({
  ...lineMetrics,
  /** Bill-level; `null` when the row is a part of bills (commodity). */
  totalDeductions: rupees.nullable(),
  /** What the kissans are owed for these bills; `null` as above. */
  netAmount: rupees.nullable(),
});

export const saleMetricsSchema = z.object({
  ...lineMetrics,
  /** Bill-level; `null` when the row is a part of bills (commodity). */
  totalCharges: rupees.nullable(),
  /** What the beoparis owe for these bills; `null` as above. */
  netAmount: rupees.nullable(),
});

/** One group: a day ("2026-11-06"), or a commodity or trader (id and name). */
const groupKey = {
  key: z.string(),
  label: z.string(),
};

const bookReport = <M extends z.ZodObject>(metrics: M) =>
  z.object({
    from: z.iso.date(),
    to: z.iso.date(),
    groupBy: z.enum(REPORT_GROUPS),
    commodity: z.uuid().nullable(),
    trader: z.uuid().nullable(),
    /** Days oldest first; commodities and traders by name. */
    rows: z.array(metrics.extend(groupKey)),
    totals: metrics,
  });

export const purchasesReportSchema = bookReport(purchaseMetricsSchema);
export const salesReportSchema = bookReport(saleMetricsSchema);

const sides = z.object({ purchases: rupees, sales: rupees, total: rupees });

export const commissionReportSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  /** Commission charged on posted bills, per day with any, oldest first. */
  days: z.array(sides.extend({ date: z.iso.date() })),
  /** The shop's commission income for the range. */
  totals: sides,
  /**
   * The other charge lines of the same bills. Not shop income: market fee
   * goes to the market committee and labour to the labourers.
   */
  otherCharges: z.object({
    marketFee: sides,
    labour: sides,
    other: sides,
  }),
});

const outstandingTrader = z.object({
  traderId: z.uuid(),
  type: z.enum(traderType.enumValues),
  name: z.string(),
  phone: z.string().nullable(),
  /** Rupees, always positive. */
  amount: rupees,
});

const outstandingSide = z.object({
  /** Every trader on this side, whatever `limit` is. */
  total: rupees,
  count,
  /** Largest first. */
  traders: z.array(outstandingTrader),
});

export const outstandingReportSchema = z.object({
  asOf: z.iso.date().nullable(),
  /** Traders who owe the shop (khata balance above 0). */
  receivable: outstandingSide,
  /** Traders the shop owes (khata balance below 0). */
  payable: outstandingSide,
});

const voucherTotals = z.object({ count, amount: rupees });

export const dailySummarySchema = z.object({
  date: z.iso.date(),
  purchases: z.object({
    bills: count,
    bags: count,
    weightKg: z.string(),
    grossAmount: rupees,
    totalDeductions: rupees,
    netAmount: rupees,
    /** Paid to kissans on the bills themselves. */
    paidOnBills: rupees,
  }),
  sales: z.object({
    bills: count,
    bags: count,
    weightKg: z.string(),
    grossAmount: rupees,
    totalCharges: rupees,
    netAmount: rupees,
    /** Received from beoparis on the bills themselves. */
    receivedOnBills: rupees,
  }),
  /** Commission charged on the day's posted bills. */
  commission: sides,
  /** Posted vouchers of the day, any method. */
  payments: z.object({ paid: voucherTotals, received: voucherTotals }),
  /** The cash book of the day (cash vouchers only). */
  cash: z.object({
    openingCash: rupees,
    cashIn: rupees,
    cashOut: rupees,
    closingCash: rupees,
  }),
  /** Documents of the day that were cancelled; left out of every total. */
  cancelled: z.object({ purchases: count, sales: count, payments: count }),
  /** The day's rates, as `GET /rates/:date` lists them. */
  rates: z.array(rateSchema),
});

export type PurchaseMetrics = z.infer<typeof purchaseMetricsSchema>;
export type SaleMetrics = z.infer<typeof saleMetricsSchema>;
export type PurchasesReport = z.infer<typeof purchasesReportSchema>;
export type SalesReport = z.infer<typeof salesReportSchema>;
export type CommissionReport = z.infer<typeof commissionReportSchema>;
export type OutstandingReport = z.infer<typeof outstandingReportSchema>;
export type DailySummary = z.infer<typeof dailySummarySchema>;

export class ReportRangeQueryDto extends createZodDto(reportRangeQuerySchema) {}
export class DailySummaryQueryDto extends createZodDto(
  dailySummaryQuerySchema,
) {}
export class BookReportQueryDto extends createZodDto(bookReportQuerySchema) {}
export class OutstandingQueryDto extends createZodDto(outstandingQuerySchema) {}
export class PurchasesReportDto extends createZodDto(purchasesReportSchema) {}
export class SalesReportDto extends createZodDto(salesReportSchema) {}
export class CommissionReportDto extends createZodDto(commissionReportSchema) {}
export class OutstandingReportDto extends createZodDto(
  outstandingReportSchema,
) {}
export class DailySummaryDto extends createZodDto(dailySummarySchema) {}
export class CashBookReportDto extends createZodDto(cashBookSchema) {}
