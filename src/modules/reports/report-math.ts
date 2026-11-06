import Decimal from 'decimal.js';
import type { ChargeType } from '../../common/charges/calculate-transaction';

/* Pure: no framework or database imports, so the maths is unit tested. */

const rupees = (v: Decimal.Value) => new Decimal(v).toFixed(2);

/** Item-level sums of one group (from the item lines of posted bills). */
export interface LineSums {
  key: string;
  label: string;
  bills: number;
  bags: number;
  weightKg: string;
  grossAmount: string;
}

/** Bill-level sums of one group (from the bills themselves). */
export interface BillSums {
  key: string;
  charges: string;
  netAmount: string;
}

export interface BookRow extends LineSums {
  /** Deductions (purchases) or charges (sales); null when not bill-level. */
  charges: string | null;
  netAmount: string | null;
}

/**
 * Joins the item-level rows of a report with the bill-level ones by key.
 * Without bill-level rows (a commodity split, where one bill's deductions
 * and net cannot be divided between its commodities) those fields are null.
 */
export function bookRows(
  lines: readonly LineSums[],
  bills: readonly BillSums[] | null,
): BookRow[] {
  const byKey = new Map(bills?.map((b) => [b.key, b]));
  return lines.map((line) => {
    const bill = bills ? byKey.get(line.key) : undefined;
    return {
      ...line,
      weightKg: new Decimal(line.weightKg).toFixed(3),
      grossAmount: rupees(line.grossAmount),
      charges: bills ? rupees(bill?.charges ?? 0) : null,
      netAmount: bills ? rupees(bill?.netAmount ?? 0) : null,
    };
  });
}

/** One charge-line sum: a day, a side (purchases or sales) and a type. */
export interface ChargeSum {
  date: string;
  side: 'purchases' | 'sales';
  type: ChargeType;
  amount: string;
}

export interface Sides {
  purchases: string;
  sales: string;
  total: string;
}

export interface CommissionTotals {
  days: (Sides & { date: string })[];
  totals: Sides;
  otherCharges: { marketFee: Sides; labour: Sides; other: Sides };
}

class SideSum {
  purchases = new Decimal(0);
  sales = new Decimal(0);

  add(side: ChargeSum['side'], amount: string): void {
    this[side] = this[side].plus(amount);
  }

  toJSON(): Sides {
    return {
      purchases: this.purchases.toFixed(2),
      sales: this.sales.toFixed(2),
      total: this.purchases.plus(this.sales).toFixed(2),
    };
  }
}

/**
 * Commission earned per day and in total, and the other charge types of the
 * same bills (not income: passed on to the market committee or labourers).
 * Days without commission are left out; days come out oldest first.
 */
export function commissionTotals(sums: readonly ChargeSum[]): CommissionTotals {
  const days = new Map<string, SideSum>();
  const totals = new SideSum();
  const other = {
    market_fee: new SideSum(),
    labour: new SideSum(),
    other: new SideSum(),
  };
  for (const sum of sums) {
    if (sum.type === 'commission') {
      let day = days.get(sum.date);
      if (!day) days.set(sum.date, (day = new SideSum()));
      day.add(sum.side, sum.amount);
      totals.add(sum.side, sum.amount);
    } else {
      other[sum.type].add(sum.side, sum.amount);
    }
  }
  return {
    days: [...days.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, day]) => ({ date, ...day.toJSON() })),
    totals: totals.toJSON(),
    otherCharges: {
      marketFee: other.market_fee.toJSON(),
      labour: other.labour.toJSON(),
      other: other.other.toJSON(),
    },
  };
}

/** A trader and its khata balance (debit − credit). */
export interface TraderBalance {
  traderId: string;
  type: 'kissan' | 'beopari' | 'arhti';
  name: string;
  phone: string | null;
  balance: string;
}

export interface OutstandingTrader extends Omit<TraderBalance, 'balance'> {
  amount: string;
}

export interface OutstandingSide {
  total: string;
  count: number;
  traders: OutstandingTrader[];
}

/**
 * Splits balances into receivable (above 0: the trader owes the shop) and
 * payable (below 0: the shop owes the trader), largest first (then by name).
 * Totals and counts cover every trader; `limit` only shortens the lists.
 */
export function outstandingSides(
  balances: readonly TraderBalance[],
  limit?: number,
): { receivable: OutstandingSide; payable: OutstandingSide } {
  const side = (sign: 1 | -1): OutstandingSide => {
    const rows = balances
      .map(({ balance, ...trader }) => ({
        ...trader,
        amount: new Decimal(balance).times(sign),
      }))
      .filter((row) => row.amount.isPositive() && !row.amount.isZero())
      .sort(
        (a, b) =>
          b.amount.comparedTo(a.amount) ||
          a.name.localeCompare(b.name) ||
          (a.traderId < b.traderId ? -1 : 1),
      );
    const total = rows.reduce(
      (sum, row) => sum.plus(row.amount),
      new Decimal(0),
    );
    return {
      total: total.toFixed(2),
      count: rows.length,
      traders: rows
        .slice(0, limit ?? rows.length)
        .map((row) => ({ ...row, amount: row.amount.toFixed(2) })),
    };
  };
  return { receivable: side(1), payable: side(-1) };
}
