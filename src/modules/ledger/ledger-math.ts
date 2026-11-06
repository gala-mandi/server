import Decimal from 'decimal.js';

/** Debit and credit of one entry, or totals of many, as numeric strings. */
export interface Amounts {
  debit: string;
  credit: string;
}

/**
 * Sign of every balance in the khata: debit minus credit.
 * Positive = the trader owes the shop (receivable); negative = the shop owes
 * the trader (payable). A purchase credits the kissan; paying the kissan
 * debits the same amount back.
 */
export function balanceOf(...amounts: Amounts[]): string {
  return amounts
    .reduce((sum, a) => sum.plus(a.debit).minus(a.credit), new Decimal(0))
    .toFixed(2);
}

/** `a + b + …` for balances, e.g. an opening balance plus a period's movement. */
export function addBalances(...balances: string[]): string {
  return balances.reduce((sum, b) => sum.plus(b), new Decimal(0)).toFixed(2);
}

/**
 * Each entry with the balance after it, starting from `opening` (the balance
 * before the first entry). Entries must be in khata order (date, then id).
 */
export function withRunningBalance<T extends Amounts>(
  opening: string,
  entries: readonly T[],
): (T & { balance: string })[] {
  let balance = new Decimal(opening);
  return entries.map((entry) => {
    balance = balance.plus(entry.debit).minus(entry.credit);
    return { ...entry, balance: balance.toFixed(2) };
  });
}

/** A balance split the way the shop reads it: what it gets and what it pays. */
export function receivablePayable(balance: string): {
  receivable: string;
  payable: string;
} {
  const b = new Decimal(balance);
  return {
    receivable: b.isPositive() && !b.isZero() ? b.toFixed(2) : '0.00',
    payable: b.isNegative() && !b.isZero() ? b.negated().toFixed(2) : '0.00',
  };
}

/**
 * The entry that cancels a balance: a positive (debit) balance is undone by a
 * credit, a negative one by a debit. `null` when there is nothing to undo.
 */
export function reversalOf(balance: string): Amounts | null {
  const b = new Decimal(balance);
  if (b.isZero()) return null;
  return b.isPositive()
    ? { debit: '0.00', credit: b.toFixed(2) }
    : { debit: b.negated().toFixed(2), credit: '0.00' };
}

/** Rupees with at most 2 decimals and at most 12 digits before the point. */
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

export class InvalidEntryError extends Error {}

/**
 * Checks the amounts of a new entry: rupee strings, never negative, exactly
 * one side above zero. Returns both sides with 2 decimals.
 */
export function entryAmounts(debit = '0', credit = '0'): Amounts {
  if (!MONEY.test(debit) || !MONEY.test(credit)) {
    throw new InvalidEntryError(
      `Amounts must be rupees with up to 2 decimals (got debit "${debit}", credit "${credit}")`,
    );
  }
  const d = new Decimal(debit);
  const c = new Decimal(credit);
  if (d.isZero() === c.isZero()) {
    throw new InvalidEntryError(
      'An entry has either a debit or a credit above 0, not both',
    );
  }
  return { debit: d.toFixed(2), credit: c.toFixed(2) };
}
