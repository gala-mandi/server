import {
  creditLimitMessage,
  DAY_CLOSED_MESSAGE,
  mayEditDay,
  overCreditLimit,
  savedRates,
} from './sale-rules';

describe('closed-day and saved-rate rules (shared with purchases)', () => {
  it('a closed day (before today) is the owner’s only', () => {
    expect(
      mayEditDay('manager', '2026-11-05', '2026-11-05', '2026-11-06'),
    ).toBe(false);
    expect(mayEditDay('owner', '2026-11-05', '2026-11-05', '2026-11-06')).toBe(
      true,
    );
    expect(
      mayEditDay('manager', '2026-11-06', '2026-11-06', '2026-11-06'),
    ).toBe(true);
    expect(DAY_CLOSED_MESSAGE).toContain('sales');
  });

  it('keeps the bill’s own rates', () => {
    expect(
      savedRates([{ type: 'commission', basis: 'percent', value: '1.00' }]),
    ).toEqual({ commissionPct: '1.00' });
  });
});

describe('overCreditLimit()', () => {
  it('no limit set → never over', () => {
    expect(
      overCreditLimit({ creditLimit: null, before: '0', after: '9999999' }),
    ).toBe(false);
  });

  it('a save that takes the balance above the limit', () => {
    expect(
      overCreditLimit({
        creditLimit: '100000.00',
        before: '50000.00',
        after: '100000.01',
      }),
    ).toBe(true);
  });

  it('exactly at the limit is fine', () => {
    expect(
      overCreditLimit({
        creditLimit: '100000.00',
        before: '0.00',
        after: '100000.00',
      }),
    ).toBe(false);
  });

  it('a limit of 0 means no credit at all', () => {
    expect(
      overCreditLimit({ creditLimit: '0.00', before: '0.00', after: '1.00' }),
    ).toBe(true);
  });

  it('a save that lowers or keeps the balance is never stopped, even above the limit', () => {
    expect(
      overCreditLimit({
        creditLimit: '100000.00',
        before: '150000.00',
        after: '120000.00',
      }),
    ).toBe(false);
    expect(
      overCreditLimit({
        creditLimit: '100000.00',
        before: '150000.00',
        after: '150000.00',
      }),
    ).toBe(false);
  });

  it('a buyer the shop owes (credit balance) stays under any limit', () => {
    expect(
      overCreditLimit({
        creditLimit: '0.00',
        before: '-5000.00',
        after: '-1000.00',
      }),
    ).toBe(false);
  });
});

describe('creditLimitMessage()', () => {
  it('names the buyer, the balance and the limit', () => {
    expect(creditLimitMessage('Bashir', '120000', '100000.00')).toBe(
      'Bashir would owe Rs 120000.00, above the credit limit of Rs 100000.00',
    );
  });
});
