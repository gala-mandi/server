import Decimal from 'decimal.js';

/**
 * Weight conversions for the mandi: kg ↔ maund (the shop's `maund_kg`,
 * normally 40) ↔ bags (a commodity's `bag_weight_kg`).
 *
 * Pure and exact: strings in, strings out, `decimal.js` in between, so no
 * float error ever reaches a weight. Weights are kg with 3 decimals, as in
 * the database (`numeric(12,3)`); inputs are rounded half-up to 3 decimals
 * before anything is worked out.
 */

/** Short unit labels shown to users. Kept here so they can be translated. */
export const UNIT_LABELS = {
  maund: 'mn',
  kg: 'kg',
  bag: 'bag',
} as const;

export type UnitLabels = { readonly [K in keyof typeof UNIT_LABELS]: string };

/** Thrown for a negative, empty or non-numeric quantity, or a zero divisor. */
export class InvalidQuantityError extends RangeError {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = 'InvalidQuantityError';
  }
}

// Enough digits for 12-digit weights divided by 3-decimal factors.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type Dec = InstanceType<typeof D>;

/** Weight scale in the database. */
const KG_DP = 3;

const NUMBER = /^\d+(\.\d+)?$/;

/** Checks a quantity of 0 or more; kept exactly as given. */
function parseExact(value: string, field: string): Dec {
  if (typeof value !== 'string' || !NUMBER.test(value.trim())) {
    throw new InvalidQuantityError(
      field,
      'must be a number of 0 or more, e.g. "1010.5"',
    );
  }
  return new D(value.trim());
}

/** A weight in kg, rounded to the database's 3 decimals. */
const parse = (value: string, field: string): Dec =>
  parseExact(value, field).toDecimalPlaces(KG_DP);

function parsePositive(value: string, field: string): Dec {
  const n = parse(value, field);
  if (n.isZero()) {
    throw new InvalidQuantityError(field, 'must be more than 0');
  }
  return n;
}

/** "1010.5" → "1010.500" (the database form of a weight). */
const fixed = (n: Dec) => n.toFixed(KG_DP);

/** "10.500" → "10.5", "25.000" → "25" (for display). */
const plain = (n: Dec) => n.toDecimalPlaces(KG_DP).toFixed();

/** Whole units plus what is left in kg, and the exact decimal amount. */
function split(kg: Dec, unitKg: Dec) {
  const whole = kg.dividedToIntegerBy(unitKg);
  return {
    whole,
    // kg and unitKg both have at most 3 decimals: the remainder is exact.
    rest: kg.minus(whole.times(unitKg)),
    total: kg.dividedBy(unitKg).toDecimalPlaces(KG_DP),
  };
}

export interface MaundWeight {
  /** Whole maunds, e.g. "25". */
  maund: string;
  /** Kg left over after the whole maunds, e.g. "10.000". */
  kg: string;
  /** The same weight in maunds with 3 decimals, e.g. "25.250". */
  totalMaund: string;
}

/** 1010 kg, maund 40 → `{ maund: "25", kg: "10.000", totalMaund: "25.250" }`. */
export function kgToMaund(kg: string, maundKg: string): MaundWeight {
  const { whole, rest, total } = split(
    parse(kg, 'kg'),
    parsePositive(maundKg, 'maundKg'),
  );
  return { maund: whole.toFixed(0), kg: fixed(rest), totalMaund: fixed(total) };
}

/** 25 maund (+ 10 kg), maund 40 → "1010.000". Maunds may have decimals. */
export function maundToKg(maund: string, maundKg: string, kg = '0'): string {
  // Maunds keep their own decimals ("25.25"); only the result is rounded.
  return fixed(
    parseExact(maund, 'maund')
      .times(parsePositive(maundKg, 'maundKg'))
      .plus(parse(kg, 'kg'))
      .toDecimalPlaces(KG_DP),
  );
}

export interface BagWeight {
  /** Whole bags, e.g. "10". */
  bags: string;
  /** Kg left over after the whole bags, e.g. "5.000". */
  kg: string;
  /** The same weight in bags with 3 decimals, e.g. "10.050". */
  totalBags: string;
}

/** 1005 kg in 100 kg bags → `{ bags: "10", kg: "5.000", totalBags: "10.050" }`. */
export function kgToBags(kg: string, bagWeightKg: string): BagWeight {
  const { whole, rest, total } = split(
    parse(kg, 'kg'),
    parsePositive(bagWeightKg, 'bagWeightKg'),
  );
  return { bags: whole.toFixed(0), kg: fixed(rest), totalBags: fixed(total) };
}

/** 12 bags of 100 kg → "1200.000". Bags may have decimals (a part bag). */
export function bagsToKg(bags: string, bagWeightKg: string): string {
  return fixed(
    parseExact(bags, 'bags')
      .times(parsePositive(bagWeightKg, 'bagWeightKg'))
      .toDecimalPlaces(KG_DP),
  );
}

/**
 * How a weight is shown: `25 mn 10 kg`, `25 mn`, `10.5 kg`, `0 kg`.
 * Pass other `labels` for another language.
 */
export function formatWeight(
  kg: string,
  maundKg: string,
  labels: UnitLabels = UNIT_LABELS,
): string {
  const { whole, rest } = split(
    parse(kg, 'kg'),
    parsePositive(maundKg, 'maundKg'),
  );
  if (whole.isZero()) return `${plain(rest)} ${labels.kg}`;
  const maund = `${whole.toFixed(0)} ${labels.maund}`;
  return rest.isZero() ? maund : `${maund} ${plain(rest)} ${labels.kg}`;
}
