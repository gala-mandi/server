import { BadRequestException, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, lte, type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { ChargeType } from '../../common/charges/calculate-transaction';
import { karachiDate } from '../../common/time/karachi-date';
import {
  commodities,
  ledgerDailyBalances,
  payments,
  purchaseCharges,
  purchaseItems,
  purchases,
  saleCharges,
  saleItems,
  sales,
  traders,
} from '../../database/schema';
import {
  TenantDatabase,
  type TenantScope,
} from '../../database/tenant-database';
import type { CashBook } from '../payments/cash-book';
import { PaymentsService } from '../payments/payments.service';
import { RatesService } from '../rates/rates.service';
import {
  type BillSums,
  type BookRow,
  bookRows,
  type ChargeSum,
  commissionTotals,
  type LineSums,
  outstandingSides,
  type TraderBalance,
} from './report-math';
import { type DateRange, reportRange } from './report-range';
import {
  type BookReportQuery,
  type CommissionReport,
  type DailySummary,
  type DailySummaryQuery,
  MAX_REPORT_DAYS,
  type OutstandingQuery,
  type OutstandingReport,
  type PurchasesReport,
  type ReportGroup,
  type ReportRangeQuery,
  type SalesReport,
} from './reports.dto';

/**
 * The columns of one book (purchases or sales) the reports read. Both books
 * have the same shape: bills, their item lines and their charge lines.
 */
interface Book {
  side: 'purchases' | 'sales';
  bills: typeof purchases | typeof sales;
  date: PgColumn;
  trader: PgColumn;
  gross: PgColumn;
  /** Deductions (purchases) or charges (sales) of the bill. */
  charges: PgColumn;
  net: PgColumn;
  /** Paid (purchases) or received (sales) on the bill itself. */
  settled: PgColumn;
  items: typeof purchaseItems | typeof saleItems;
  itemBill: PgColumn;
  chargeLines: typeof purchaseCharges | typeof saleCharges;
  chargeBill: PgColumn;
}

const PURCHASES: Book = {
  side: 'purchases',
  bills: purchases,
  date: purchases.purchaseDate,
  trader: purchases.traderId,
  gross: purchases.grossAmount,
  charges: purchases.totalDeductions,
  net: purchases.netAmount,
  settled: purchases.paidAmount,
  items: purchaseItems,
  itemBill: purchaseItems.purchaseId,
  chargeLines: purchaseCharges,
  chargeBill: purchaseCharges.purchaseId,
};

const SALES: Book = {
  side: 'sales',
  bills: sales,
  date: sales.saleDate,
  trader: sales.buyerId,
  gross: sales.grossAmount,
  charges: sales.totalCharges,
  net: sales.netAmount,
  settled: sales.receivedAmount,
  items: saleItems,
  itemBill: saleItems.saleId,
  chargeLines: saleCharges,
  chargeBill: saleCharges.saleId,
};

interface BookFilter extends DateRange {
  commodity?: string;
  trader?: string;
}

interface BookResult {
  rows: BookRow[];
  totals: Omit<BookRow, 'key' | 'label'>;
}

// Sums are cast wider than the columns: a year of bills can pass 14 digits.
const money = (column: PgColumn | SQL) =>
  sql<string>`coalesce(sum(${column}), 0)::numeric(20,2)::text`;
const kg = (column: PgColumn) =>
  sql<string>`coalesce(sum(${column}), 0)::numeric(20,3)::text`;
const intSum = (column: PgColumn) =>
  sql<number>`coalesce(sum(${column}), 0)::int`;
const billCount = (column: PgColumn) =>
  sql<number>`count(distinct ${column})::int`;

const invalid = (errors: { field: string; message: string }[]) =>
  new BadRequestException({ message: 'Validation failed', errors });

/**
 * The shop's reports (owner and manager). Read-only: every query runs in the
 * caller's shop through `TenantDatabase` (tenant filter plus RLS). Only
 * posted documents count; cancelled ones (and soft-deleted rows, such as the
 * old lines of an edited bill) are left out of every total.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly payments: PaymentsService,
    private readonly rates: RatesService,
  ) {}

  /** `GET /reports/daily-summary`: one day of the shop at a glance. */
  dailySummary(
    query: DailySummaryQuery,
    now: Date = new Date(),
  ): Promise<DailySummary> {
    const date = query.date ?? karachiDate(now);
    const range = { from: date, to: date };
    return this.db.transaction(async (scope) => {
      // One after the other: queries on one transaction never overlap.
      const bought = await this.bookTotals(scope, PURCHASES, range);
      const sold = await this.bookTotals(scope, SALES, range);
      const charges = await this.chargeSums(scope, range);
      const vouchers = await this.voucherTotals(scope, date);
      const cash: CashBook = await this.payments.cashBookOf(scope, date, date);
      const cancelled = {
        purchases: await this.cancelledOn(scope, PURCHASES, date),
        sales: await this.cancelledOn(scope, SALES, date),
        payments: await this.cancelledPayments(scope, date),
      };
      const rates = await this.rates.ratesOf(scope, date);

      return {
        date,
        purchases: {
          bills: bought.bills,
          bags: bought.bags,
          weightKg: bought.weightKg,
          grossAmount: bought.grossAmount,
          totalDeductions: bought.charges,
          netAmount: bought.netAmount,
          paidOnBills: bought.settled,
        },
        sales: {
          bills: sold.bills,
          bags: sold.bags,
          weightKg: sold.weightKg,
          grossAmount: sold.grossAmount,
          totalCharges: sold.charges,
          netAmount: sold.netAmount,
          receivedOnBills: sold.settled,
        },
        commission: commissionTotals(charges).totals,
        payments: vouchers,
        cash: {
          openingCash: cash.openingCash,
          cashIn: cash.totals.cashIn,
          cashOut: cash.totals.cashOut,
          closingCash: cash.closingCash,
        },
        cancelled,
        rates,
      };
    });
  }

  /** `GET /reports/purchases`: bought from kissans, grouped. */
  async purchases(
    query: BookReportQuery,
    now: Date = new Date(),
  ): Promise<PurchasesReport> {
    const { range, result } = await this.bookReport(PURCHASES, query, now);
    const metrics = ({ charges, ...rest }: Omit<BookRow, 'key' | 'label'>) => ({
      ...rest,
      totalDeductions: charges,
    });
    return {
      ...range,
      rows: result.rows.map((row) => ({
        ...metrics(row),
        key: row.key,
        label: row.label,
      })),
      totals: metrics(result.totals),
    };
  }

  /** `GET /reports/sales`: sold to beoparis, grouped. */
  async sales(
    query: BookReportQuery,
    now: Date = new Date(),
  ): Promise<SalesReport> {
    const { range, result } = await this.bookReport(SALES, query, now);
    const metrics = ({ charges, ...rest }: Omit<BookRow, 'key' | 'label'>) => ({
      ...rest,
      totalCharges: charges,
    });
    return {
      ...range,
      rows: result.rows.map((row) => ({
        ...metrics(row),
        key: row.key,
        label: row.label,
      })),
      totals: metrics(result.totals),
    };
  }

  /** `GET /reports/commission`: the shop's commission income. */
  commission(
    query: ReportRangeQuery,
    now: Date = new Date(),
  ): Promise<CommissionReport> {
    const range = this.range(query, now);
    return this.db.transaction(async (scope) => ({
      ...range,
      ...commissionTotals(await this.chargeSums(scope, range)),
    }));
  }

  /** `GET /reports/outstanding`: receivable and payable from the khata. */
  outstanding(query: OutstandingQuery): Promise<OutstandingReport> {
    return this.db.transaction(async ({ tx, tenantId, scoped }) => {
      const day = ledgerDailyBalances;
      // The same source as `GET /ledger/balances`: the daily totals the
      // ledger trigger keeps, one row per trader and day.
      const sums = tx
        .select({
          traderId: day.traderId,
          balance: sql<string>`sum(${day.debit}) - sum(${day.credit})`.as(
            'balance',
          ),
        })
        .from(day)
        .where(
          and(
            eq(day.tenantId, tenantId),
            query.asOf ? lte(day.entryDate, query.asOf) : undefined,
          ),
        )
        .groupBy(day.traderId)
        .as('sums');
      const rows: TraderBalance[] = await tx
        .select({
          traderId: traders.id,
          type: traders.type,
          name: traders.name,
          phone: traders.phone,
          balance: sql<string>`${sums.balance}::text`,
        })
        .from(traders)
        .innerJoin(sums, eq(sums.traderId, traders.id))
        .where(
          scoped(traders).where(
            and(
              query.type ? eq(traders.type, query.type) : undefined,
              sql`${sums.balance} <> 0`,
            ),
          ),
        );
      return {
        asOf: query.asOf ?? null,
        ...outstandingSides(rows, query.limit),
      };
    });
  }

  /** `GET /reports/cash-book`: the payments cash book, unchanged. */
  cashBook(query: ReportRangeQuery, now: Date = new Date()): Promise<CashBook> {
    return this.payments.cashBook(query, now);
  }

  /* ---------------------------------------------------------------- */

  private range(query: ReportRangeQuery, now: Date): DateRange {
    const range = reportRange(query, MAX_REPORT_DAYS, now);
    if (Array.isArray(range)) throw invalid(range);
    return range;
  }

  private async bookReport(book: Book, query: BookReportQuery, now: Date) {
    const range = this.range(query, now);
    const filter: BookFilter = {
      ...range,
      commodity: query.commodity,
      trader: query.trader,
    };
    const result = await this.db.transaction((scope) =>
      this.grouped(scope, book, query.groupBy, filter),
    );
    return {
      range: {
        ...range,
        groupBy: query.groupBy,
        commodity: query.commodity ?? null,
        trader: query.trader ?? null,
      },
      result,
    };
  }

  /** Posted bills of the book in the range (and of the trader, if any). */
  private billsWhere({ scoped }: TenantScope, book: Book, filter: BookFilter) {
    return scoped(book.bills).where(
      and(
        eq(book.bills.status, 'posted'),
        gte(book.date, filter.from),
        lte(book.date, filter.to),
        filter.trader ? eq(book.trader, filter.trader) : undefined,
      ),
    );
  }

  /** Live item lines of those bills (and of the commodity, if any). */
  private linesWhere(scope: TenantScope, book: Book, filter: BookFilter) {
    return and(
      scope
        .scoped(book.items)
        .where(
          filter.commodity
            ? eq(book.items.commodityId, filter.commodity)
            : undefined,
        ),
      this.billsWhere(scope, book, filter),
    );
  }

  private async grouped(
    scope: TenantScope,
    book: Book,
    groupBy: ReportGroup,
    filter: BookFilter,
  ): Promise<BookResult> {
    const { tx } = scope;
    const { items, bills } = book;
    // A commodity split cuts bills apart: their deductions and net can't be.
    const billLevel = groupBy !== 'commodity' && !filter.commodity;

    const lineMetrics = {
      bills: billCount(bills.id),
      bags: intSum(items.bags),
      weightKg: kg(items.weightKg),
      grossAmount: money(items.amount),
    };

    let lines: LineSums[];
    if (groupBy === 'day') {
      lines = await tx
        .select({
          key: sql<string>`${book.date}::text`,
          label: sql<string>`${book.date}::text`,
          ...lineMetrics,
        })
        .from(items)
        .innerJoin(bills, eq(bills.id, book.itemBill))
        .where(this.linesWhere(scope, book, filter))
        .groupBy(book.date)
        .orderBy(asc(book.date));
    } else if (groupBy === 'commodity') {
      lines = await tx
        .select({
          key: sql<string>`${commodities.id}::text`,
          label: commodities.name,
          ...lineMetrics,
        })
        .from(items)
        .innerJoin(bills, eq(bills.id, book.itemBill))
        // Inner join with soft-deleted ones too: old bills keep their names.
        .innerJoin(commodities, eq(commodities.id, items.commodityId))
        .where(this.linesWhere(scope, book, filter))
        .groupBy(commodities.id, commodities.name)
        .orderBy(asc(commodities.name), asc(commodities.id));
    } else {
      lines = await tx
        .select({
          key: sql<string>`${traders.id}::text`,
          label: traders.name,
          ...lineMetrics,
        })
        .from(items)
        .innerJoin(bills, eq(bills.id, book.itemBill))
        .innerJoin(traders, eq(traders.id, book.trader))
        .where(this.linesWhere(scope, book, filter))
        .groupBy(traders.id, traders.name)
        .orderBy(asc(traders.name), asc(traders.id));
    }

    let billRows: BillSums[] | null = null;
    if (billLevel) {
      const key = groupBy === 'day' ? book.date : book.trader;
      billRows = await tx
        .select({
          key: sql<string>`${key}::text`,
          charges: money(book.charges),
          netAmount: money(book.net),
        })
        .from(bills)
        .where(this.billsWhere(scope, book, filter))
        .groupBy(key);
    }

    const totals = await this.bookTotals(scope, book, filter);
    return {
      rows: bookRows(lines, billRows),
      totals: {
        bills: totals.bills,
        bags: totals.bags,
        weightKg: totals.weightKg,
        grossAmount: totals.grossAmount,
        charges: filter.commodity ? null : totals.charges,
        netAmount: filter.commodity ? null : totals.netAmount,
      },
    };
  }

  /** Whole-range totals of a book: item lines and bills. */
  private async bookTotals(scope: TenantScope, book: Book, filter: BookFilter) {
    const { tx } = scope;
    const [lines] = await tx
      .select({
        bills: billCount(book.bills.id),
        bags: intSum(book.items.bags),
        weightKg: kg(book.items.weightKg),
        grossAmount: money(book.items.amount),
      })
      .from(book.items)
      .innerJoin(book.bills, eq(book.bills.id, book.itemBill))
      .where(this.linesWhere(scope, book, filter));
    const [bills] = await tx
      .select({
        charges: money(book.charges),
        netAmount: money(book.net),
        settled: money(book.settled),
      })
      .from(book.bills)
      .where(this.billsWhere(scope, book, filter));
    return { ...lines, ...bills };
  }

  /** Charge lines of posted bills in the range, by day, side and type. */
  private async chargeSums(
    scope: TenantScope,
    range: DateRange,
  ): Promise<ChargeSum[]> {
    const sums: ChargeSum[] = [];
    for (const book of [PURCHASES, SALES]) {
      const lines = book.chargeLines;
      const rows = await scope.tx
        .select({
          date: sql<string>`${book.date}::text`,
          type: lines.type,
          amount: money(lines.amount),
        })
        .from(lines)
        .innerJoin(book.bills, eq(book.bills.id, book.chargeBill))
        .where(
          and(scope.scoped(lines).where(), this.billsWhere(scope, book, range)),
        )
        .groupBy(book.date, lines.type);
      for (const row of rows) {
        sums.push({
          date: row.date,
          side: book.side,
          type: row.type as ChargeType,
          amount: row.amount,
        });
      }
    }
    return sums;
  }

  /** Posted vouchers of the day by direction, any method. */
  private async voucherTotals({ tx, scoped }: TenantScope, date: string) {
    const rows = await tx
      .select({
        direction: payments.direction,
        count: sql<number>`count(*)::int`,
        amount: money(payments.amount),
      })
      .from(payments)
      .where(
        scoped(payments).where(
          and(eq(payments.status, 'posted'), eq(payments.paymentDate, date)),
        ),
      )
      .groupBy(payments.direction);
    const of = (direction: string) => {
      const row = rows.find((r) => r.direction === direction);
      return { count: row?.count ?? 0, amount: row?.amount ?? '0.00' };
    };
    return { paid: of('paid'), received: of('received') };
  }

  private async cancelledOn(
    { tx, scoped }: TenantScope,
    book: Book,
    date: string,
  ): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(book.bills)
      .where(
        scoped(book.bills).where(
          and(eq(book.bills.status, 'cancelled'), eq(book.date, date)),
        ),
      );
    return row.n;
  }

  private async cancelledPayments(
    { tx, scoped }: TenantScope,
    date: string,
  ): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payments)
      .where(
        scoped(payments).where(
          and(eq(payments.status, 'cancelled'), eq(payments.paymentDate, date)),
        ),
      );
    return row.n;
  }
}
