import { cashBook } from './cash-book';

describe('cashBook()', () => {
  it('carries the cash in hand from day to day', () => {
    expect(
      cashBook('2026-11-01', '2026-11-06', '5000.00', [
        { date: '2026-11-02', cashIn: '100000.00', cashOut: '40000.00' },
        { date: '2026-11-05', cashIn: '0.00', cashOut: '70000.50' },
      ]),
    ).toEqual({
      from: '2026-11-01',
      to: '2026-11-06',
      openingCash: '5000.00',
      days: [
        {
          date: '2026-11-02',
          cashIn: '100000.00',
          cashOut: '40000.00',
          closingCash: '65000.00',
        },
        {
          date: '2026-11-05',
          cashIn: '0.00',
          cashOut: '70000.50',
          closingCash: '-5000.50',
        },
      ],
      totals: { cashIn: '100000.00', cashOut: '110000.50' },
      closingCash: '-5000.50',
    });
  });

  it('a range without cash vouchers closes at the opening cash', () => {
    expect(cashBook('2026-11-06', '2026-11-06', '1200', [])).toEqual({
      from: '2026-11-06',
      to: '2026-11-06',
      openingCash: '1200.00',
      days: [],
      totals: { cashIn: '0.00', cashOut: '0.00' },
      closingCash: '1200.00',
    });
  });
});
