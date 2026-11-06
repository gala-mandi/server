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
import { calculatePurchase } from '../purchases/purchase-totals';
import { calculateSale, type SaleItemInput } from './sale-totals';

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
const TICKET: SaleItemInput = {
  weightKg: '1000',
  rate: '4000',
  rateUnit: 'maund',
  bags: 10,
  charges: standard('2', '0.5', '20'),
};

const ODD: SaleItemInput = { ...TICKET, weightKg: '1000.333' };

function itemError(fn: () => unknown): InvalidQuantityError {
  try {
    fn();
  } catch (error) {
    if (error instanceof InvalidQuantityError) return error;
    throw error;
  }
  throw new Error('expected an InvalidQuantityError');
}

const asItem = (input: TransactionInput): SaleItemInput => ({
  weightKg: input.weightKg,
  rate: input.rate,
  rateUnit: input.rateUnit,
  bags: input.bags,
  charges: input.charges,
});

describe('calculateSale()', () => {
  it('charges are added: gross 100,000 + charges 2,700 = net 102,700', () => {
    expect(calculateSale([TICKET], '40')).toEqual({
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
      totalCharges: '2700.00',
      rounding: '0.00',
      netAmount: '102700.00',
    });
  });

  it('is the purchase’s mirror: same gross and charges, opposite direction', () => {
    const sale = calculateSale([ODD, TICKET], '40');
    const purchase = calculatePurchase([ODD, TICKET], '40');
    expect(sale.itemAmounts).toEqual(purchase.itemAmounts);
    expect(sale.charges).toEqual(purchase.charges);
    expect(sale.totalCharges).toBe(purchase.totalDeductions);
  });

  // The sale fixtures of the shared calculator, as given.
  const saleFixtures = FIXTURES.filter(
    ({ input, expected }) => input.kind === 'sale' && expected.net !== '0.00',
  );

  it.each(saleFixtures)(
    'one item gives exactly the shared calculator’s result: $name',
    ({ input, expected }) => {
      expect(calculateSale([asItem(input)], input.maundKg)).toEqual({
        itemAmounts: [expected.gross],
        grossAmount: expected.gross,
        charges: expected.charges.map((c) => ({
          ...c,
          value: new Decimal(c.value).toFixed(2),
        })),
        totalCharges: expected.totalCharges,
        rounding: expected.rounding,
        netAmount: expected.net,
      });
    },
  );

  // Every fixture's item, sold: lines that can't merge, not Rs 0.
  const asSales = FIXTURES.filter(({ input }) => {
    const keys = input.charges.map((c) => `${c.type}|${c.basis}|${c.value}`);
    if (new Set(keys).size !== keys.length) return false;
    try {
      return calculateTransaction({ ...input, kind: 'sale' }).net !== '0.00';
    } catch {
      return false;
    }
  });

  it.each(asSales)(
    'the same item sold equals calculateTransaction(kind sale): $name',
    ({ input }) => {
      const one = calculateTransaction({ ...input, kind: 'sale' });
      expect(calculateSale([asItem(input)], input.maundKg)).toEqual({
        itemAmounts: [one.gross],
        grossAmount: one.gross,
        charges: one.charges,
        totalCharges: one.totalCharges,
        rounding: one.rounding,
        netAmount: one.net,
      });
    },
  );

  it('sums the items before rounding the net once', () => {
    const totals = calculateSale([ODD, ODD], '40');

    expect(totals).toMatchObject({
      itemAmounts: ['100033.30', '100033.30'],
      grossAmount: '200066.60',
      totalCharges: '5401.66',
      netAmount: '205468.00',
    });
    expect(totals.charges.map((c) => c.amount)).toEqual([
      '4001.33',
      '1000.33',
      '400.00',
    ]);
  });

  it('the parchi always adds up: gross + charges + rounding = net', () => {
    const bills = [
      [TICKET],
      [ODD],
      [ODD, ODD],
      [
        ODD,
        { ...TICKET, weightKg: '10.01', bags: null, rateUnit: 'kg' as const },
      ],
    ];
    for (const items of bills) {
      const t = calculateSale(items, '40');
      expect(
        new Decimal(t.grossAmount)
          .plus(t.totalCharges)
          .plus(t.rounding)
          .toFixed(2),
      ).toBe(t.netAmount);
      expect(
        t.itemAmounts.reduce((s, a) => s.plus(a), new Decimal(0)).toFixed(2),
      ).toBe(t.grossAmount);
      expect(
        t.charges.reduce((s, c) => s.plus(c.amount), new Decimal(0)).toFixed(2),
      ).toBe(t.totalCharges);
      expect(new Decimal(t.netAmount).isInteger()).toBe(true);
    }
  });

  it('items at different rates get their own line, in parchi order', () => {
    const cotton: SaleItemInput = {
      weightKg: '500',
      rate: '120',
      rateUnit: 'kg',
      bags: 5,
      charges: standard('3', '0.5', '20'),
    };

    const totals = calculateSale([ODD, cotton], '40');

    expect(totals.charges.map((c) => [c.type, c.value, c.amount])).toEqual([
      ['commission', '2.00', '2000.67'],
      ['commission', '3.00', '1800.00'],
      ['market_fee', '0.50', '800.17'],
      ['labour', '20.00', '300.00'],
    ]);
    expect(totals.grossAmount).toBe('160033.30');
    expect(totals.netAmount).toBe('164934.00');
  });

  it('large charges are fine on a sale (they are added, never above the gross)', () => {
    const totals = calculateSale(
      [
        {
          ...TICKET,
          charges: [{ type: 'other', basis: 'fixed', value: '200000' }],
        },
      ],
      '40',
    );
    expect(totals.netAmount).toBe('300000.00');
  });

  it('uses the shop’s kg per maund', () => {
    expect(calculateSale([TICKET], '37.324').grossAmount).toBe('107169.65');
  });

  it('refuses a bill without items', () => {
    expect(itemError(() => calculateSale([], '40'))).toMatchObject({
      field: 'items',
    });
  });

  it('names the item of a bad weight, rate or missing bags', () => {
    expect(
      itemError(() =>
        calculateSale([TICKET, { ...TICKET, weightKg: '0' }], '40'),
      ),
    ).toMatchObject({
      field: 'items.1.weightKg',
      message: 'items.1.weightKg: must be more than 0',
    });
    expect(
      itemError(() =>
        calculateSale([{ ...TICKET, rateUnit: 'bag', bags: null }], '40'),
      ).field,
    ).toBe('items.0.bags');
    expect(
      itemError(() => calculateSale([{ ...TICKET, rate: '-1' }], '40')).field,
    ).toBe('items.0.rate');
  });

  it('refuses a bill whose net comes to Rs 0', () => {
    expect(
      itemError(() =>
        calculateSale(
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
    expect(() => calculateSale([big], '40')).toThrow(InvalidQuantityError);
  });
});
