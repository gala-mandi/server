import type {
  ChargeInput,
  TransactionBreakdown,
  TransactionInput,
} from './calculate-transaction';

/**
 * Shared examples for `calculateTransaction()`. The web app runs the same
 * fixtures against its copy of the calculator, so both sides must give
 * these exact strings (contract test).
 */
export interface TransactionFixture {
  name: string;
  input: TransactionInput;
  expected: TransactionBreakdown;
}

/** Commission 2%, market fee 0.5%, labour Rs 20 per bag. */
const STANDARD: ChargeInput[] = [
  { type: 'commission', basis: 'percent', value: '2.00' },
  { type: 'market_fee', basis: 'percent', value: '0.50' },
  { type: 'labour', basis: 'per_bag', value: '20.00' },
];

const noCharges = {
  charges: [],
  totalCharges: '0.00',
  rounding: '0.00',
};

export const TRANSACTION_FIXTURES: TransactionFixture[] = [
  {
    name: '1,000 kg at Rs 4,000 per maund (40 kg) → gross Rs 100,000',
    input: {
      kind: 'purchase',
      weightKg: '1000',
      rate: '4000',
      rateUnit: 'maund',
      maundKg: '40',
      charges: [],
    },
    expected: { gross: '100000.00', ...noCharges, net: '100000.00' },
  },
  {
    name: 'purchase: commission 2% + market fee 0.5% + labour Rs 20 × 10 bags',
    input: {
      kind: 'purchase',
      weightKg: '1000',
      rate: '4000',
      rateUnit: 'maund',
      maundKg: '40',
      bags: 10,
      charges: STANDARD,
    },
    expected: {
      gross: '100000.00',
      charges: [
        { ...STANDARD[0], amount: '2000.00' },
        { ...STANDARD[1], amount: '500.00' },
        { ...STANDARD[2], amount: '200.00' },
      ],
      totalCharges: '2700.00',
      rounding: '0.00',
      net: '97300.00',
    },
  },
  {
    name: 'sale: the same charges are added to what the beopari owes',
    input: {
      kind: 'sale',
      weightKg: '1000',
      rate: '4000',
      rateUnit: 'maund',
      maundKg: '40',
      bags: 10,
      charges: STANDARD,
    },
    expected: {
      gross: '100000.00',
      charges: [
        { ...STANDARD[0], amount: '2000.00' },
        { ...STANDARD[1], amount: '500.00' },
        { ...STANDARD[2], amount: '200.00' },
      ],
      totalCharges: '2700.00',
      rounding: '0.00',
      net: '102700.00',
    },
  },
  {
    name: 'net rounded to the nearest rupee: 97,332.4675 → 97,332 (−0.46)',
    input: {
      kind: 'purchase',
      weightKg: '1000.333',
      rate: '4000',
      rateUnit: 'maund',
      maundKg: '40',
      bags: 10,
      charges: STANDARD,
    },
    expected: {
      gross: '100033.30',
      charges: [
        { ...STANDARD[0], amount: '2000.67' }, // 2000.666
        { ...STANDARD[1], amount: '500.17' }, // 500.1665
        { ...STANDARD[2], amount: '200.00' },
      ],
      totalCharges: '2700.84',
      rounding: '-0.46',
      net: '97332.00',
    },
  },
  {
    name: 'net rounded up: 1,000.60 → 1,001 (+0.40)',
    input: {
      kind: 'purchase',
      weightKg: '10.006',
      rate: '100',
      rateUnit: 'kg',
      maundKg: '40',
      charges: [],
    },
    expected: {
      gross: '1000.60',
      charges: [],
      totalCharges: '0.00',
      rounding: '0.40',
      net: '1001.00',
    },
  },
  {
    name: 'exactly half a rupee rounds up: 100.50 → 101',
    input: {
      kind: 'purchase',
      weightKg: '1.005',
      rate: '100',
      rateUnit: 'kg',
      maundKg: '40',
      charges: [],
    },
    expected: {
      gross: '100.50',
      charges: [],
      totalCharges: '0.00',
      rounding: '0.50',
      net: '101.00',
    },
  },
  {
    name: 'rounding once at the end: 99.495 → 99, not 99.50 → 100',
    input: {
      kind: 'sale',
      weightKg: '99',
      rate: '1',
      rateUnit: 'kg',
      maundKg: '40',
      charges: [{ type: 'market_fee', basis: 'percent', value: '0.50' }],
    },
    expected: {
      gross: '99.00',
      charges: [
        // 0.495 exact, shown as 0.50; the net uses the exact value.
        { type: 'market_fee', basis: 'percent', value: '0.50', amount: '0.50' },
      ],
      totalCharges: '0.50',
      rounding: '-0.50',
      net: '99.00',
    },
  },
  {
    name: 'rate per kg: 1,010.5 kg at Rs 100/kg',
    input: {
      kind: 'purchase',
      weightKg: '1010.5',
      rate: '100',
      rateUnit: 'kg',
      maundKg: '40',
      charges: [],
    },
    expected: { gross: '101050.00', ...noCharges, net: '101050.00' },
  },
  {
    name: 'rate per maund gives the same as the kg rate: 1,010.5 kg at Rs 4,000/mn',
    input: {
      kind: 'purchase',
      weightKg: '1010.5',
      rate: '4000',
      rateUnit: 'maund',
      maundKg: '40',
      charges: [],
    },
    expected: { gross: '101050.00', ...noCharges, net: '101050.00' },
  },
  {
    name: 'maund rate is exact, not rate × rounded maunds: 1,010.5 kg at Rs 3,999/mn',
    input: {
      kind: 'purchase',
      weightKg: '1010.5',
      rate: '3999',
      rateUnit: 'maund',
      maundKg: '40',
      charges: [],
    },
    // 1010.5 × 3999 ÷ 40 = 101024.7375 (25.263 mn × 3999 would be 101026.74).
    expected: {
      gross: '101024.74',
      charges: [],
      totalCharges: '0.00',
      rounding: '0.26',
      net: '101025.00',
    },
  },
  {
    name: "uses the shop's maund_kg: 373.24 kg with maund = 37.324 kg is 10 mn",
    input: {
      kind: 'purchase',
      weightKg: '373.24',
      rate: '1000',
      rateUnit: 'maund',
      maundKg: '37.324',
      charges: [],
    },
    expected: { gross: '10000.00', ...noCharges, net: '10000.00' },
  },
  {
    name: 'rate per bag: 10 bags at Rs 3,500/bag',
    input: {
      kind: 'purchase',
      weightKg: '1000',
      rate: '3500',
      rateUnit: 'bag',
      maundKg: '40',
      bags: 10,
      charges: [],
    },
    expected: { gross: '35000.00', ...noCharges, net: '35000.00' },
  },
  {
    name: 'fixed "other" charge, and per-bag labour without bags is 0',
    input: {
      kind: 'purchase',
      weightKg: '1000',
      rate: '4000',
      rateUnit: 'maund',
      maundKg: '40',
      charges: [
        { type: 'labour', basis: 'per_bag', value: '20.00' },
        { type: 'other', basis: 'fixed', value: '150' },
      ],
    },
    expected: {
      gross: '100000.00',
      charges: [
        { type: 'labour', basis: 'per_bag', value: '20.00', amount: '0.00' },
        { type: 'other', basis: 'fixed', value: '150.00', amount: '150.00' },
      ],
      totalCharges: '150.00',
      rounding: '0.00',
      net: '99850.00',
    },
  },
  {
    name: 'rate 0 → everything 0',
    input: {
      kind: 'purchase',
      weightKg: '1000',
      rate: '0',
      rateUnit: 'kg',
      maundKg: '40',
      charges: [{ type: 'commission', basis: 'percent', value: '2.00' }],
    },
    expected: {
      gross: '0.00',
      charges: [
        {
          type: 'commission',
          basis: 'percent',
          value: '2.00',
          amount: '0.00',
        },
      ],
      totalCharges: '0.00',
      rounding: '0.00',
      net: '0.00',
    },
  },
  {
    name: 'very large: 999,999,999.999 kg at Rs 999.99/kg still fits numeric(14,2)',
    input: {
      kind: 'purchase',
      weightKg: '999999999.999',
      rate: '999.99',
      rateUnit: 'kg',
      maundKg: '40',
      charges: [],
    },
    expected: {
      gross: '999989999999.00',
      ...noCharges,
      net: '999989999999.00',
    },
  },
];
