import Decimal from 'decimal.js';
import { InvalidQuantityError } from '../units/units';

/**
 * The one calculator for a purchase or sale line: gross amount, each
 * charge, and the net. Purchases, sales, previews and reports all call it,
 * so their totals always match.
 *
 * Pure and exact: strings in, strings out, `decimal.js` in between. All
 * maths is done on exact values; amounts are shown to paisa (2 decimals,
 * half-up) and the net is rounded **once at the end** to the nearest rupee
 * (half-up). The `rounding` line is the difference, so the parchi adds up:
 * `gross ∓ totalCharges + rounding = net`.
 *
 * Direction: on a purchase the charges are deductions from what the kissan
 * gets (`net = gross − charges`); on a sale they are added to what the
 * beopari owes (`net = gross + charges`).
 *
 * No framework imports, so the web app can use the same file.
 */

export const TRANSACTION_KINDS = ['purchase', 'sale'] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** What the rate is per: 1 kg, 1 maund (the shop's `maund_kg`) or 1 bag. */
export const RATE_UNITS = ['kg', 'maund', 'bag'] as const;
export type RateUnit = (typeof RATE_UNITS)[number];

/** Same values as `purchase_charges.type` / `sale_charges.type`. */
export const CHARGE_TYPES = [
  'commission',
  'market_fee',
  'labour',
  'other',
] as const;
export type ChargeType = (typeof CHARGE_TYPES)[number];

/**
 * Same values as `purchase_charges.basis`: percent of the gross, rupees per
 * bag, or a fixed rupee amount.
 */
export const CHARGE_BASES = ['percent', 'per_bag', 'fixed'] as const;
export type ChargeBasis = (typeof CHARGE_BASES)[number];

export interface ChargeInput {
  type: ChargeType;
  basis: ChargeBasis;
  /** "2.00" (%), "20.00" (Rs per bag) or "150.00" (Rs). */
  value: string;
}

export interface TransactionInput {
  kind: TransactionKind;
  /** Net weight in kg, more than 0. */
  weightKg: string;
  /** Rupees per `rateUnit`, 0 or more. */
  rate: string;
  rateUnit: RateUnit;
  /** The shop's `maund_kg` (normally "40"). */
  maundKg: string;
  /** Number of bags; needed for per-bag rates and per-bag charges. */
  bags?: number | null;
  /** Charge lines in parchi order. */
  charges: readonly ChargeInput[];
}

/** One charge on the parchi; maps 1:1 to a `purchase_charges` row. */
export interface ChargeLine extends ChargeInput {
  /** Rupees, 2 decimals. */
  amount: string;
}

export interface TransactionBreakdown {
  /** Weight × rate, 2 decimals. */
  gross: string;
  charges: ChargeLine[];
  /** Sum of the charge lines (`total_deductions` / `total_charges`). */
  totalCharges: string;
  /** What the net was rounded by, e.g. "-0.46" or "0.50". */
  rounding: string;
  /** Payable to the kissan / receivable from the beopari, whole rupees. */
  net: string;
}

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type Dec = InstanceType<typeof D>;

const MONEY_DP = 2;
const KG_DP = 3;
/** Largest `numeric(14,2)`. */
const MAX_MONEY = new D('999999999999.99');

const NUMBER = /^\d+(\.\d+)?$/;

/** A number of 0 or more, rounded half-up to the database scale. */
function parse(value: string, field: string, dp: number): Dec {
  if (typeof value !== 'string' || !NUMBER.test(value.trim())) {
    throw new InvalidQuantityError(
      field,
      'must be a number of 0 or more, e.g. "1010.5"',
    );
  }
  return new D(value.trim()).toDecimalPlaces(dp);
}

function parsePositive(value: string, field: string, dp: number): Dec {
  const n = parse(value, field, dp);
  if (n.isZero()) throw new InvalidQuantityError(field, 'must be more than 0');
  return n;
}

function parseBags(bags: number | null | undefined): Dec | null {
  if (bags === null || bags === undefined) return null;
  if (!Number.isSafeInteger(bags) || bags < 0) {
    throw new InvalidQuantityError('bags', 'must be a whole number, 0 or more');
  }
  return new D(bags);
}

function oneOf<T extends string>(
  list: readonly T[],
  value: T,
  field: string,
): void {
  if (!list.includes(value)) {
    throw new InvalidQuantityError(field, `must be one of ${list.join(', ')}`);
  }
}

/** Money to its stored form; refuses what `numeric(14,2)` can't hold. */
function money(n: Dec, field: string): string {
  const rounded = n.toDecimalPlaces(MONEY_DP);
  if (rounded.abs().greaterThan(MAX_MONEY)) {
    throw new InvalidQuantityError(field, 'is too large');
  }
  return rounded.toFixed(MONEY_DP);
}

function grossOf(input: TransactionInput, bags: Dec | null): Dec {
  const weightKg = parsePositive(input.weightKg, 'weightKg', KG_DP);
  const rate = parse(input.rate, 'rate', MONEY_DP);
  oneOf(RATE_UNITS, input.rateUnit, 'rateUnit');
  switch (input.rateUnit) {
    case 'kg':
      return weightKg.times(rate);
    case 'maund':
      // Exact: weight × rate ÷ maund, not rate × a rounded maund count.
      return weightKg
        .times(rate)
        .dividedBy(parsePositive(input.maundKg, 'maundKg', KG_DP));
    case 'bag':
      if (bags === null || bags.isZero()) {
        throw new InvalidQuantityError('bags', 'are needed for a per-bag rate');
      }
      return bags.times(rate);
  }
}

function chargeAmount(
  charge: ChargeInput,
  value: Dec,
  gross: Dec,
  bags: Dec | null,
): Dec {
  switch (charge.basis) {
    case 'percent':
      return gross.times(value).dividedBy(100);
    case 'per_bag':
      return bags === null ? new D(0) : bags.times(value);
    case 'fixed':
      return value;
  }
}

/**
 * 1,000 kg at Rs 4,000 per maund, 10 bags, commission 2%, market fee 0.5%,
 * labour Rs 20/bag → gross "100000.00", charges 2000 + 500 + 200, net
 * "97300.00" on a purchase.
 *
 * Throws `InvalidQuantityError` for a zero or bad weight, a negative or
 * bad rate or charge, a per-bag rate without bags, a percent over 100,
 * an amount too large for `numeric(14,2)`, or a purchase whose charges are
 * more than its gross.
 */
export function calculateTransaction(
  input: TransactionInput,
): TransactionBreakdown {
  oneOf(TRANSACTION_KINDS, input.kind, 'kind');
  const bags = parseBags(input.bags);
  const gross = grossOf(input, bags);
  const grossText = money(gross, 'gross');

  let total = new D(0);
  let shownTotal = new D(0);
  const charges = input.charges.map((charge, i): ChargeLine => {
    const field = `charges[${i}]`;
    oneOf(CHARGE_TYPES, charge.type, `${field}.type`);
    oneOf(CHARGE_BASES, charge.basis, `${field}.basis`);
    const value = parse(charge.value, `${field}.value`, MONEY_DP);
    if (charge.basis === 'percent' && value.greaterThan(100)) {
      throw new InvalidQuantityError(`${field}.value`, 'must be 100 or less');
    }
    const amount = chargeAmount(charge, value, gross, bags);
    const amountText = money(amount, `${field}.amount`);
    total = total.plus(amount);
    shownTotal = shownTotal.plus(amountText);
    return {
      type: charge.type,
      basis: charge.basis,
      value: value.toFixed(MONEY_DP),
      amount: amountText,
    };
  });
  const totalText = money(shownTotal, 'totalCharges');

  const sign = input.kind === 'purchase' ? -1 : 1;
  const exactNet = gross.plus(total.times(sign));
  if (exactNet.isNegative()) {
    throw new InvalidQuantityError('charges', 'are more than the gross amount');
  }
  // The only rounding: exact net → whole rupees, half-up.
  const net = exactNet.toDecimalPlaces(0);
  const shownNet = new D(grossText).plus(shownTotal.times(sign));

  return {
    gross: grossText,
    charges,
    totalCharges: totalText,
    rounding: net.minus(shownNet).toFixed(MONEY_DP),
    net: money(net, 'net'),
  };
}
