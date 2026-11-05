/** Documents that get a bill (parchi) number. */
export const DOC_TYPES = ['purchase', 'sale', 'payment', 'receipt'] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** Prefix used when the shop has not set `bill_prefix` in its settings. */
export const DEFAULT_PREFIXES: Record<DocType, string> = {
  purchase: 'PUR',
  sale: 'SAL',
  payment: 'PAY',
  receipt: 'RCT',
};

/** Pakistan's financial year starts on 1 July. */
export const DEFAULT_FINANCIAL_YEAR_START = '07-01';

const SHOP_TIME_ZONE = 'Asia/Karachi';
const NUMBER_DIGITS = 6;

/** The shop's calendar date (Asia/Karachi) of `at`, as YYYY-MM-DD. */
export function shopDate(at: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Financial year label of a date: `2026-27` for a year that starts in 2026
 * and ends in 2027, or `2026` when the year starts on 1 January.
 *
 * @param date YYYY-MM-DD
 * @param yearStart the shop's `financial_year_start` (YYYY-MM-DD, only month
 *   and day are used) or null for the 1 July default
 */
export function financialYear(date: string, yearStart: string | null): string {
  const startMonthDay = yearStart
    ? yearStart.slice(5)
    : DEFAULT_FINANCIAL_YEAR_START;
  const year = Number(date.slice(0, 4));
  if (startMonthDay === '01-01') return String(year);
  const startYear = date.slice(5) >= startMonthDay ? year : year - 1;
  const endYear = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endYear}`;
}

/** `{prefix}-{FY}-{000123}`, e.g. `PUR-2026-27-000123`. */
export function formatBillNumber(
  prefix: string,
  year: string,
  number: number,
): string {
  if (!Number.isInteger(number) || number < 1) {
    throw new RangeError(`Bill number must be a positive integer: ${number}`);
  }
  return `${prefix}-${year}-${String(number).padStart(NUMBER_DIGITS, '0')}`;
}
