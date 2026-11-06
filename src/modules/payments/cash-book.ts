import Decimal from 'decimal.js';

/** Cash received and paid on one day (posted cash vouchers). */
export interface CashDay {
  /** YYYY-MM-DD */
  date: string;
  cashIn: string;
  cashOut: string;
}

export interface CashBook {
  from: string;
  to: string;
  /** Cash in hand at the start of `from`. */
  openingCash: string;
  days: (CashDay & { closingCash: string })[];
  totals: { cashIn: string; cashOut: string };
  /** Cash in hand at the end of `to`. */
  closingCash: string;
}

/**
 * The cash book of a date range: each day with cash movement, its cash in
 * and out, and the cash in hand at its end (opening + in − out, carried
 * from day to day). `days` must be in date order.
 */
export function cashBook(
  from: string,
  to: string,
  openingCash: string,
  days: readonly CashDay[],
): CashBook {
  let cash = new Decimal(openingCash);
  let cashIn = new Decimal(0);
  let cashOut = new Decimal(0);
  const rows = days.map((day) => {
    cash = cash.plus(day.cashIn).minus(day.cashOut);
    cashIn = cashIn.plus(day.cashIn);
    cashOut = cashOut.plus(day.cashOut);
    return {
      date: day.date,
      cashIn: new Decimal(day.cashIn).toFixed(2),
      cashOut: new Decimal(day.cashOut).toFixed(2),
      closingCash: cash.toFixed(2),
    };
  });
  return {
    from,
    to,
    openingCash: new Decimal(openingCash).toFixed(2),
    days: rows,
    totals: { cashIn: cashIn.toFixed(2), cashOut: cashOut.toFixed(2) },
    closingCash: cash.toFixed(2),
  };
}
