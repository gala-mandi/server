import {
  bookRows,
  commissionTotals,
  outstandingSides,
  type TraderBalance,
} from './report-math';

describe('bookRows()', () => {
  const lines = [
    {
      key: '2026-06-30',
      label: '2026-06-30',
      bills: 2,
      bags: 30,
      weightKg: '3000',
      grossAmount: '300000',
    },
    {
      key: '2026-07-01',
      label: '2026-07-01',
      bills: 1,
      bags: 0,
      weightKg: '12.5',
      grossAmount: '1250.5',
    },
  ];

  it('joins bill-level sums by key and formats every amount', () => {
    expect(
      bookRows(lines, [
        { key: '2026-07-01', charges: '25.01', netAmount: '1225' },
        { key: '2026-06-30', charges: '8100', netAmount: '291900' },
      ]),
    ).toEqual([
      {
        ...lines[0],
        weightKg: '3000.000',
        grossAmount: '300000.00',
        charges: '8100.00',
        netAmount: '291900.00',
      },
      {
        ...lines[1],
        weightKg: '12.500',
        grossAmount: '1250.50',
        charges: '25.01',
        netAmount: '1225.00',
      },
    ]);
  });

  it('a commodity split has no bill-level fields', () => {
    const [row] = bookRows(lines.slice(0, 1), null);
    expect(row.charges).toBeNull();
    expect(row.netAmount).toBeNull();
  });
});

describe('commissionTotals()', () => {
  it('commission per day and in total; other charges apart', () => {
    const result = commissionTotals([
      { date: '2026-07-01', side: 'sales', type: 'commission', amount: '0.10' },
      {
        date: '2026-06-30',
        side: 'purchases',
        type: 'commission',
        amount: '2000.00',
      },
      {
        date: '2026-07-01',
        side: 'purchases',
        type: 'commission',
        amount: '0.20',
      },
      {
        date: '2026-06-30',
        side: 'purchases',
        type: 'market_fee',
        amount: '500',
      },
      { date: '2026-06-30', side: 'sales', type: 'labour', amount: '200' },
      { date: '2026-06-30', side: 'sales', type: 'other', amount: '1.5' },
    ]);
    expect(result).toEqual({
      days: [
        {
          date: '2026-06-30',
          purchases: '2000.00',
          sales: '0.00',
          total: '2000.00',
        },
        // Exact decimals: 0.1 + 0.2 is 0.30, not 0.30000000000000004.
        { date: '2026-07-01', purchases: '0.20', sales: '0.10', total: '0.30' },
      ],
      totals: { purchases: '2000.20', sales: '0.10', total: '2000.30' },
      otherCharges: {
        marketFee: { purchases: '500.00', sales: '0.00', total: '500.00' },
        labour: { purchases: '0.00', sales: '200.00', total: '200.00' },
        other: { purchases: '0.00', sales: '1.50', total: '1.50' },
      },
    });
  });

  it('nothing charged is all zeros', () => {
    const zero = { purchases: '0.00', sales: '0.00', total: '0.00' };
    expect(commissionTotals([])).toEqual({
      days: [],
      totals: zero,
      otherCharges: { marketFee: zero, labour: zero, other: zero },
    });
  });
});

describe('outstandingSides()', () => {
  const t = (
    name: string,
    balance: string,
    type: TraderBalance['type'] = 'beopari',
  ): TraderBalance => ({
    traderId: `id-${name}`,
    type,
    name,
    phone: null,
    balance,
  });

  it('positive balances are receivable, negative payable, largest first', () => {
    const result = outstandingSides([
      t('Bashir', '5000.00'),
      t('Akram', '-97300.00', 'kissan'),
      t('Zafar', '0.00'),
      t('Anwar', '5000.00'),
      t('Kamal', '120000.50'),
      t('Dilawar', '-0.01', 'kissan'),
    ]);
    expect(result.receivable).toEqual({
      total: '130000.50',
      count: 3,
      traders: [
        {
          traderId: 'id-Kamal',
          type: 'beopari',
          name: 'Kamal',
          phone: null,
          amount: '120000.50',
        },
        // Same amount: by name.
        {
          traderId: 'id-Anwar',
          type: 'beopari',
          name: 'Anwar',
          phone: null,
          amount: '5000.00',
        },
        {
          traderId: 'id-Bashir',
          type: 'beopari',
          name: 'Bashir',
          phone: null,
          amount: '5000.00',
        },
      ],
    });
    expect(result.payable).toEqual({
      total: '97300.01',
      count: 2,
      traders: [
        {
          traderId: 'id-Akram',
          type: 'kissan',
          name: 'Akram',
          phone: null,
          amount: '97300.00',
        },
        {
          traderId: 'id-Dilawar',
          type: 'kissan',
          name: 'Dilawar',
          phone: null,
          amount: '0.01',
        },
      ],
    });
  });

  it('limit shortens the lists, not the totals', () => {
    const result = outstandingSides(
      [t('A', '10'), t('B', '20'), t('C', '30')],
      2,
    );
    expect(result.receivable.total).toBe('60.00');
    expect(result.receivable.count).toBe(3);
    expect(result.receivable.traders.map((r) => r.name)).toEqual(['C', 'B']);
  });
});
