import Decimal from 'decimal.js';
import {
  CHARGE_TYPES,
  calculateTransaction,
  type ChargeInput,
  type ChargeLine,
  type RateUnit,
} from '../../common/charges/calculate-transaction';
import { InvalidQuantityError } from '../../common/units/units';

/**
 * Totals of a whole sale (one or more items), built on the shared one-item
 * calculator (kind `'sale'`) and its rounding rule: exact maths, lines shown
 * to paisa (2 decimals, half-up), the net rounded **once** at the end to the
 * nearest rupee (half-up). On a sale the charges are added to what the
 * beopari owes: `net = gross + charges`.
 *
 * The twin of `calculatePurchase()`; for a single item the result is
 * exactly `calculateTransaction({ kind: 'sale', … })`'s.
 *
 * Pure, no framework imports, so the web form can use the same file.
 */

export interface SaleItemInput {
  /** Net weight in kg. */
  weightKg: string;
  /** Rupees per `rateUnit`. */
  rate: string;
  rateUnit: RateUnit;
  bags?: number | null;
  /**
   * This item's charges in parchi order, e.g.
   * `standardCharges(effectiveCharges(commodity, shop, manual))`.
   */
  charges: readonly ChargeInput[];
}

export interface SaleTotals {
  /** Each item's amount (weight × rate), 2 decimals, in input order. */
  itemAmounts: string[];
  /** Sum of the item amounts. */
  grossAmount: string;
  /**
   * One line per charge type, basis and value, in parchi order (by type,
   * then first seen), like a purchase.
   */
  charges: ChargeLine[];
  /** Sum of the charge lines. */
  totalCharges: string;
  /** `netAmount − (grossAmount + totalCharges)`, e.g. "0.46". */
  rounding: string;
  /** Receivable from the beopari, whole rupees. */
  netAmount: string;
}

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type Dec = InstanceType<typeof D>;

const MONEY_DP = 2;
const KG_DP = 3;
const MAX_MONEY = new D('999999999999.99');

/** Same rounding of inputs as the one-item calculator. */
const num = (value: string, dp: number): Dec =>
  new D(value.trim()).toDecimalPlaces(dp);

function money(n: Dec, field: string): string {
  const rounded = n.toDecimalPlaces(MONEY_DP);
  if (rounded.abs().greaterThan(MAX_MONEY)) {
    throw new InvalidQuantityError(field, 'is too large');
  }
  return rounded.toFixed(MONEY_DP);
}

/** The one-item calculator's error, with the item's place in front. */
function itemError(index: number, error: InvalidQuantityError) {
  const message = error.message.slice(error.field.length + 2);
  const field =
    error.field === 'charges'
      ? `items.${index}`
      : `items.${index}.${error.field}`;
  return new InvalidQuantityError(field, message);
}

/**
 * @throws InvalidQuantityError for no items, a bad item (field
 *   `items.<i>.<field>`), a net of Rs 0, or an amount too large for
 *   `numeric(14,2)`
 */
export function calculateSale(
  items: readonly SaleItemInput[],
  maundKg: string,
): SaleTotals {
  if (!items.length) {
    throw new InvalidQuantityError('items', 'add at least one item');
  }

  const itemAmounts: string[] = [];
  const groups = new Map<string, { line: ChargeInput; exact: Dec }>();
  let exactGross = new D(0);
  let exactCharges = new D(0);

  items.forEach((item, i) => {
    let shown: ReturnType<typeof calculateTransaction>;
    try {
      // Checks the item and gives its amount exactly as a one-item bill.
      shown = calculateTransaction({ kind: 'sale', maundKg, ...item });
    } catch (error) {
      if (error instanceof InvalidQuantityError) throw itemError(i, error);
      throw error;
    }
    itemAmounts.push(shown.gross);

    // The same maths again, kept exact so the items add up before rounding.
    const weight = num(item.weightKg, KG_DP);
    const rate = num(item.rate, MONEY_DP);
    const bags = item.bags ?? null;
    const gross =
      item.rateUnit === 'kg'
        ? weight.times(rate)
        : item.rateUnit === 'maund'
          ? weight.times(rate).dividedBy(num(maundKg, KG_DP))
          : new D(bags ?? 0).times(rate);
    exactGross = exactGross.plus(gross);

    for (const charge of item.charges) {
      const value = num(charge.value, MONEY_DP);
      const amount =
        charge.basis === 'percent'
          ? gross.times(value).dividedBy(100)
          : charge.basis === 'per_bag'
            ? new D(bags ?? 0).times(value)
            : value;
      exactCharges = exactCharges.plus(amount);
      const line = { ...charge, value: value.toFixed(MONEY_DP) };
      const key = `${line.type}|${line.basis}|${line.value}`;
      const group = groups.get(key);
      if (group) group.exact = group.exact.plus(amount);
      else groups.set(key, { line, exact: amount });
    }
  });

  // Parchi order (commission, market fee, labour, other); stable sort keeps
  // first-seen order within a type.
  const ordered = [...groups.values()].sort(
    (a, b) =>
      CHARGE_TYPES.indexOf(a.line.type) - CHARGE_TYPES.indexOf(b.line.type),
  );
  const charges = ordered.map(({ line, exact }, i): ChargeLine => ({
    type: line.type,
    basis: line.basis,
    value: line.value,
    amount: money(exact, `charges.${i}.amount`),
  }));
  const grossAmount = money(
    itemAmounts.reduce((sum, a) => sum.plus(a), new D(0)),
    'grossAmount',
  );
  const totalCharges = money(
    charges.reduce((sum, c) => sum.plus(c.amount), new D(0)),
    'totalCharges',
  );

  // The only rounding: exact net → whole rupees, half-up.
  const net = exactGross.plus(exactCharges).toDecimalPlaces(0);
  if (net.isZero()) {
    throw new InvalidQuantityError('items', 'the net amount comes to Rs 0');
  }
  const shownNet = new D(grossAmount).plus(totalCharges);

  return {
    itemAmounts,
    grossAmount,
    charges,
    totalCharges,
    rounding: net.minus(shownNet).toFixed(MONEY_DP),
    netAmount: money(net, 'netAmount'),
  };
}
