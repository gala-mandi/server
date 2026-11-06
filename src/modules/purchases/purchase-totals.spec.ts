import Decimal from 'decimal.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  calculateTransaction,
  type ChargeInput,
  type TransactionBreakdown,
  type TransactionInput,
} from '../../common/charges/calculate-transaction';
import { InvalidQuantityError } from '../../common/units/units';
import { calculatePurchase, type PurchaseItemInput } from './purchase-totals';

const FIXTURES = JSON.parse(
  readFileSync(
    join(__dirname, '../../common/charges/calculate-transaction.fixtures.json'),
    'utf8',
  ),
) as {
  name: string;
  input: TransactionInput;
  expected: TransactionBreakdown;
}[];

const standard = (
  commission: string,
  marketFee: string,
  labour: string,
): ChargeInput[] => [
  { type: 'commission', basis: 'percent', value: commission },
  { type: 'market_fee', basis: 'percent', value: marketFee },
  { type: 'labour', basis: 'per_bag', value: labour },
];

/** 1,000 kg at Rs 4,000/maund, 10 bags, 2% + 0.5% + Rs 20/bag. */
const TICKET: PurchaseItemInput = {
  weightKg: '1000',
  rate: '4000',
  rateUnit: 'maund',
  bags: 10,
  charges: standard('2', '0.5', '20'),
};

/** The ticket 19 rounding example: net 97,332.00, rounding -0.46. */
const ODD: PurchaseItemInput = { ...TICKET, weightKg: '1000.333' };

function itemError(fn: () => unknown): InvalidQuantityError {
  try {
    fn();
  } catch (error) {
    if (error instanceof InvalidQuantityError) return error;
    throw error;
  }
  throw new Error('expected an InvalidQuantityError');
}

describe('calculatePurchase()', () => {
  it('ticket example: gross 100,000, deductions 2,700, net 97,300', () => {
    expect(calculatePurchase([TICKET], '40')).toEqual({
      itemAmounts: ['100000.00'],
      grossAmount: '100000.00',
      charges: [
        {
          type: 'commission',
          basis: 'percent',
          value: '2.00',
          amount: '2000.00',
        },
        {
          type: 'market_fee',
          basis: 'percent',
          value: '0.50',
          amount: '500.00',
        },
        { type: 'labour', basis: 'per_bag', value: '20.00', amount: '200.00' },
      ],
      totalDeductions: '2700.00',
      rounding: '0.00',
      netAmount: '97300.00',
    });
  });

  // Fixtures whose charge lines can't merge (two equal lines would become
  // one), and not Rs 0 (a purchase of nothing is refused).
  const single = FIXTURES.filter(({ input, expected }) => {
    const keys = input.charges.map((c) => `${c.type}|${c.basis}|${c.value}`);
    return (
      input.kind === 'purchase' &&
      expected.net !== '0.00' &&
      new Set(keys).size === keys.length
    );
  });

  it.each(single)(
    'one item gives exactly the shared calculator’s result: $name',
    ({ input, expected }) => {
      const totals = calculatePurchase(
        [
          {
            weightKg: input.weightKg,
            rate: input.rate,
            rateUnit: input.rateUnit,
            bags: input.bags,
            charges: input.charges,
          },
        ],
        input.maundKg,
      );
      expect(totals).toEqual({
        itemAmounts: [expected.gross],
        grossAmount: expected.gross,
        charges: expected.charges.map((c) => ({
          ...c,
          value: new Decimal(c.value).toFixed(2),
        })),
        totalDeductions: expected.totalCharges,
        rounding: expected.rounding,
        netAmount: expected.net,
      });
    },
  );

  it('sums the items before rounding: two ×97,332.46 → 194,665, not 2 × 97,332', () => {
    expect(
      calculateTransaction({ kind: 'purchase', maundKg: '40', ...ODD }).net,
    ).toBe('97332.00');

    const totals = calculatePurchase([ODD, ODD], '40');

    expect(totals).toEqual({
      itemAmounts: ['100033.30', '100033.30'],
      grossAmount: '200066.60',
      charges: [
        {
          type: 'commission',
          basis: 'percent',
          value: '2.00',
          amount: '4001.33',
        },
        {
          type: 'market_fee',
          basis: 'percent',
          value: '0.50',
          amount: '1000.33',
        },
        { type: 'labour', basis: 'per_bag', value: '20.00', amount: '400.00' },
      ],
      totalDeductions: '5401.66',
      rounding: '0.06',
      netAmount: '194665.00',
    });
  });

  it('the parchi always adds up: gross − deductions + rounding = net', () => {
    const bills = [
      [TICKET],
      [ODD, ODD],
      [
        ODD,
        { ...TICKET, weightKg: '10.01', bags: null, rateUnit: 'kg' as const },
      ],
    ];
    for (const items of bills) {
      const t = calculatePurchase(items, '40');
      expect(
        new Decimal(t.grossAmount)
          .minus(t.totalDeductions)
          .plus(t.rounding)
          .toFixed(2),
      ).toBe(t.netAmount);
      expect(
        t.itemAmounts.reduce((s, a) => s.plus(a), new Decimal(0)).toFixed(2),
      ).toBe(t.grossAmount);
      expect(
        t.charges.reduce((s, c) => s.plus(c.amount), new Decimal(0)).toFixed(2),
      ).toBe(t.totalDeductions);
    }
  });

  it('items at different rates get their own line, in parchi order', () => {
    const cotton: PurchaseItemInput = {
      weightKg: '500',
      rate: '120',
      rateUnit: 'kg',
      bags: 5,
      charges: standard('3', '0.5', '20'),
    };

    const totals = calculatePurchase([ODD, cotton], '40');

    expect(totals.charges).toEqual([
      {
        type: 'commission',
        basis: 'percent',
        value: '2.00',
        amount: '2000.67',
      },
      {
        type: 'commission',
        basis: 'percent',
        value: '3.00',
        amount: '1800.00',
      },
      { type: 'market_fee', basis: 'percent', value: '0.50', amount: '800.17' },
      { type: 'labour', basis: 'per_bag', value: '20.00', amount: '300.00' },
    ]);
    expect(totals.grossAmount).toBe('160033.30');
    expect(totals.netAmount).toBe('155132.00');
  });

  it('per-bag rate and per-bag labour without bags', () => {
    const totals = calculatePurchase(
      [
        { ...TICKET, rateUnit: 'bag', rate: '5000', bags: 20 },
        { ...TICKET, bags: null },
      ],
      '40',
    );
    expect(totals.itemAmounts).toEqual(['100000.00', '100000.00']);
    // Labour only on the 20 bags of the first item.
    expect(totals.charges.find((c) => c.type === 'labour')?.amount).toBe(
      '400.00',
    );
  });

  it('uses the shop’s kg per maund', () => {
    expect(calculatePurchase([TICKET], '37.324').grossAmount).toBe('107169.65');
  });

  it('refuses a bill without items', () => {
    expect(itemError(() => calculatePurchase([], '40'))).toMatchObject({
      field: 'items',
    });
  });

  it('names the item of a bad weight, rate or missing bags', () => {
    expect(
      itemError(() =>
        calculatePurchase([TICKET, { ...TICKET, weightKg: '0' }], '40'),
      ),
    ).toMatchObject({
      field: 'items.1.weightKg',
      message: 'items.1.weightKg: must be more than 0',
    });
    expect(
      itemError(() =>
        calculatePurchase([{ ...TICKET, rateUnit: 'bag', bags: null }], '40'),
      ).field,
    ).toBe('items.0.bags');
    expect(
      itemError(() => calculatePurchase([{ ...TICKET, rate: '-1' }], '40'))
        .field,
    ).toBe('items.0.rate');
  });

  it('refuses deductions above an item’s amount', () => {
    expect(
      itemError(() =>
        calculatePurchase(
          [
            {
              ...TICKET,
              charges: [{ type: 'other', basis: 'fixed', value: '200000' }],
            },
          ],
          '40',
        ),
      ).field,
    ).toBe('items.0');
  });

  it('refuses a bill whose net comes to Rs 0', () => {
    expect(
      itemError(() =>
        calculatePurchase(
          [
            {
              ...TICKET,
              weightKg: '0.001',
              rateUnit: 'kg',
              rate: '100',
              charges: [],
            },
          ],
          '40',
        ),
      ),
    ).toMatchObject({ field: 'items' });
  });

  it('refuses a total too large for numeric(14,2)', () => {
    const big = {
      ...TICKET,
      weightKg: '999999999',
      rate: '999999999999',
      rateUnit: 'kg' as const,
      charges: [],
    };
    expect(() => calculatePurchase([big], '40')).toThrow(InvalidQuantityError);
  });
});
