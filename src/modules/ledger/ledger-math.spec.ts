import {
  addBalances,
  balanceOf,
  entryAmounts,
  InvalidEntryError,
  receivablePayable,
  reversalOf,
  withRunningBalance,
} from './ledger-math';

const debit = (amount: string) => ({ debit: amount, credit: '0.00' });
const credit = (amount: string) => ({ debit: '0.00', credit: amount });

describe('balanceOf', () => {
  it('is 0.00 for no entries', () => {
    expect(balanceOf()).toBe('0.00');
  });

  it('is debit minus credit', () => {
    // Purchase Rs 100,000 credits the kissan; paying the kissan Rs 40,000 debits the khata.
    expect(balanceOf(credit('100000.00'), debit('40000.00'))).toBe('-60000.00');
  });

  it('adds paise exactly (no float error)', () => {
    expect(balanceOf(debit('0.10'), debit('0.20'))).toBe('0.30');
    expect(
      balanceOf(...Array.from({ length: 1000 }, () => debit('0.01'))),
    ).toBe('10.00');
  });

  it('keeps the largest numeric(14,2) amounts exact', () => {
    expect(balanceOf(debit('999999999999.99'), debit('999999999999.99'))).toBe(
      '1999999999999.98',
    );
  });

  it('takes totals as Postgres returns them ("0", "1500")', () => {
    expect(balanceOf({ debit: '1500', credit: '0' })).toBe('1500.00');
  });
});

describe('addBalances', () => {
  it('carries an opening balance into a period', () => {
    expect(addBalances('-100000.00', '40000.00')).toBe('-60000.00');
    expect(addBalances()).toBe('0.00');
  });
});

describe('withRunningBalance', () => {
  it('starts from the opening balance and adds each entry in order', () => {
    const rows = withRunningBalance('-25000.00', [
      { id: 1, ...credit('100000.00') },
      { id: 2, ...debit('40000.00') },
      { id: 3, ...debit('85000.50') },
    ]);

    expect(rows.map((r) => [r.id, r.balance])).toEqual([
      [1, '-125000.00'],
      [2, '-85000.00'],
      [3, '0.50'],
    ]);
  });

  it('keeps every other field of the entry', () => {
    const [row] = withRunningBalance('0', [
      { id: 7, narration: 'Purchase', ...debit('10.00') },
    ]);
    expect(row).toEqual({
      id: 7,
      narration: 'Purchase',
      debit: '10.00',
      credit: '0.00',
      balance: '10.00',
    });
  });

  it('returns nothing for no entries', () => {
    expect(withRunningBalance('500.00', [])).toEqual([]);
  });

  it('page 2 continues where page 1 ended', () => {
    const entries = [
      debit('100.00'),
      credit('30.00'),
      debit('5.55'),
      credit('200.00'),
    ];
    const all = withRunningBalance('1000.00', entries);
    // Page 2 of 2: its opening is the opening plus page 1's entries.
    const carried = addBalances('1000.00', balanceOf(...entries.slice(0, 2)));
    const page2 = withRunningBalance(carried, entries.slice(2));

    expect(page2.map((r) => r.balance)).toEqual(
      all.slice(2).map((r) => r.balance),
    );
    expect(page2.at(-1)?.balance).toBe('875.55');
  });
});

describe('opening balance for a date range', () => {
  // Entries before `from` give the opening; the range adds up to the closing.
  const before = [debit('5000.00'), credit('1200.00')];
  const range = [credit('100000.00'), debit('40000.00')];

  it('is the balance of everything before the range', () => {
    expect(balanceOf(...before)).toBe('3800.00');
  });

  it('closing = opening + the range, and equals the last running balance', () => {
    const opening = balanceOf(...before);
    const closing = addBalances(opening, balanceOf(...range));
    const rows = withRunningBalance(opening, range);

    expect(closing).toBe('-56200.00');
    expect(rows.at(-1)?.balance).toBe(closing);
    // Same as the balance of the whole khata up to the range's end.
    expect(balanceOf(...before, ...range)).toBe(closing);
  });
});

describe('receivablePayable', () => {
  it('a positive balance is receivable (the trader owes the shop)', () => {
    expect(receivablePayable('2500.50')).toEqual({
      receivable: '2500.50',
      payable: '0.00',
    });
  });

  it('a negative balance is payable (the shop owes the trader)', () => {
    expect(receivablePayable('-60000.00')).toEqual({
      receivable: '0.00',
      payable: '60000.00',
    });
  });

  it('zero is neither', () => {
    for (const zero of ['0', '0.00', '-0.00']) {
      expect(receivablePayable(zero)).toEqual({
        receivable: '0.00',
        payable: '0.00',
      });
    }
  });
});

describe('reversalOf', () => {
  it('a credit balance (purchase) is undone by a debit', () => {
    expect(reversalOf('-100000.00')).toEqual(debit('100000.00'));
  });

  it('a debit balance (sale) is undone by a credit', () => {
    expect(reversalOf('750.25')).toEqual(credit('750.25'));
  });

  it('nothing to undo at 0', () => {
    expect(reversalOf('0.00')).toBeNull();
  });

  it('brings the balance back to before', () => {
    const purchase = credit('100000.00');
    const reversal = reversalOf(balanceOf(purchase));
    expect(balanceOf(purchase, reversal!)).toBe('0.00');
  });
});

describe('entryAmounts', () => {
  it('fills the other side with 0.00 and adds 2 decimals', () => {
    expect(entryAmounts('100000')).toEqual(debit('100000.00'));
    expect(entryAmounts(undefined, '40000.5')).toEqual(credit('40000.50'));
    expect(entryAmounts('0', '12.34')).toEqual(credit('12.34'));
  });

  it.each([
    ['both zero', '0', '0'],
    ['both sides', '10', '10'],
    ['nothing', undefined, undefined],
  ])('refuses %s', (_, d, c) => {
    expect(() => entryAmounts(d, c)).toThrow(InvalidEntryError);
  });

  it.each(['-5', '1.234', '1e5', 'abc', '', '1000000000000'])(
    'refuses the amount "%s"',
    (amount) => {
      expect(() => entryAmounts(amount)).toThrow(InvalidEntryError);
    },
  );
});
