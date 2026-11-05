import Decimal from 'decimal.js';
import {
  effectiveCharges,
  standardCharges,
} from '../../modules/commodities/effective-charges';
import { InvalidQuantityError } from '../units/units';
import {
  calculateTransaction,
  type RateUnit,
  type TransactionInput,
} from './calculate-transaction';
import { TRANSACTION_FIXTURES } from './calculate-transaction.fixtures';

const base: TransactionInput = {
  kind: 'purchase',
  weightKg: '1000',
  rate: '4000',
  rateUnit: 'maund',
  maundKg: '40',
  bags: 10,
  charges: [],
};

describe('calculateTransaction()', () => {
  it.each(TRANSACTION_FIXTURES)('$name', ({ input, expected }) => {
    expect(calculateTransaction(input)).toEqual(expected);
  });

  it('every fixture adds up on the parchi: gross ∓ charges + rounding = net', () => {
    for (const { input, expected } of TRANSACTION_FIXTURES) {
      const sign = input.kind === 'purchase' ? -1 : 1;
      const sum = expected.charges.reduce(
        (t, c) => t.plus(c.amount),
        new Decimal(0),
      );
      expect(sum.toFixed(2)).toBe(expected.totalCharges);
      expect(
        new Decimal(expected.gross)
          .plus(new Decimal(expected.totalCharges).times(sign))
          .plus(expected.rounding)
          .toFixed(2),
      ).toBe(expected.net);
    }
  });

  it('does not change its input', () => {
    const input = {
      ...base,
      charges: [{ type: 'other', basis: 'fixed', value: '1' }] as const,
    };
    const copy = JSON.parse(JSON.stringify(input)) as unknown;
    calculateTransaction(input);
    expect(input).toEqual(copy);
  });

  describe('charge sources', () => {
    const shop = {
      defaultCommissionPct: '2.00',
      marketFeePct: '0.50',
      labourPerBag: '20.00',
    };
    const none = {
      commissionPct: null,
      marketFeePct: null,
      labourPerBag: null,
    };
    const amounts = (charges: ReturnType<typeof effectiveCharges>) =>
      calculateTransaction({
        ...base,
        charges: standardCharges(charges),
      }).charges.map((c) => c.amount);

    it('shop default when nothing else is set', () => {
      expect(amounts(effectiveCharges(none, shop))).toEqual([
        '2000.00',
        '500.00',
        '200.00',
      ]);
    });

    it('commodity override present → override used instead of shop default', () => {
      expect(
        amounts(effectiveCharges({ ...none, commissionPct: '3.00' }, shop)),
      ).toEqual(['3000.00', '500.00', '200.00']);
    });

    it('manual override on the entry beats the commodity override', () => {
      expect(
        amounts(
          effectiveCharges({ ...none, commissionPct: '3.00' }, shop, {
            commissionPct: '1.00',
            labourPerBag: '0.00',
          }),
        ),
      ).toEqual(['1000.00', '500.00', '0.00']);
    });
  });

  describe('validation errors', () => {
    const fails = (patch: Partial<TransactionInput>, field: string) => {
      const run = () => calculateTransaction({ ...base, ...patch });
      expect(run).toThrow(InvalidQuantityError);
      expect(run).toThrow(new RegExp(`^${field.replace(/[[\]]/g, '\\$&')}:`));
    };

    it('zero weight', () => fails({ weightKg: '0' }, 'weightKg'));
    it('weight that rounds to 0 kg', () =>
      fails({ weightKg: '0.0004' }, 'weightKg'));
    it('negative weight', () => fails({ weightKg: '-5' }, 'weightKg'));
    it('negative rate', () => fails({ rate: '-4000' }, 'rate'));
    it('rate that is not a number', () => fails({ rate: '4,000' }, 'rate'));
    it('empty rate', () => fails({ rate: '' }, 'rate'));
    it('maund of 0 kg', () => fails({ maundKg: '0' }, 'maundKg'));
    it('unknown rate unit', () =>
      fails({ rateUnit: 'ton' as RateUnit }, 'rateUnit'));
    it('per-bag rate without bags', () =>
      fails({ rateUnit: 'bag', bags: null }, 'bags'));
    it('per-bag rate with 0 bags', () =>
      fails({ rateUnit: 'bag', bags: 0 }, 'bags'));
    it('part bag', () => fails({ bags: 2.5 }, 'bags'));
    it('negative bags', () => fails({ bags: -1 }, 'bags'));
    it('negative charge', () =>
      fails(
        { charges: [{ type: 'other', basis: 'fixed', value: '-10' }] },
        'charges[0].value',
      ));
    it('percent over 100', () =>
      fails(
        {
          charges: [
            { type: 'commission', basis: 'percent', value: '2' },
            { type: 'commission', basis: 'percent', value: '100.01' },
          ],
        },
        'charges[1].value',
      ));
    it('purchase charges more than the gross', () =>
      fails(
        {
          weightKg: '1',
          rate: '10',
          rateUnit: 'kg',
          bags: 1,
          charges: [{ type: 'labour', basis: 'per_bag', value: '20' }],
        },
        'charges',
      ));
    it('gross too large for numeric(14,2)', () =>
      fails(
        { weightKg: '999999999.999', rate: '1001', rateUnit: 'kg' },
        'gross',
      ));
  });

  it('100% commission on a purchase leaves 0, sale charges may exceed gross', () => {
    const full = [
      { type: 'commission', basis: 'percent', value: '100' },
    ] as const;
    expect(calculateTransaction({ ...base, charges: full }).net).toBe('0.00');
    expect(
      calculateTransaction({
        ...base,
        kind: 'sale',
        charges: [{ type: 'other', basis: 'fixed', value: '200000' }],
      }).net,
    ).toBe('300000.00');
  });

  it('inputs are taken at the database scale (kg 3, money 2 decimals)', () => {
    expect(
      calculateTransaction({
        ...base,
        weightKg: '1000.0004',
        rate: '4000.004',
        rateUnit: 'kg',
        bags: null,
      }).gross,
    ).toBe('4000000.00');
  });
});
