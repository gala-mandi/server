import {
  allocate,
  type BillState,
  outstandingOf,
  overpaymentOf,
  owedOf,
} from './payment-allocation';

const KISSAN = 'kissan-1';
const OTHER = 'kissan-2';

function bill(over: Partial<BillState> = {}): BillState {
  return {
    billNo: 'PUR-2026-27-000001',
    traderId: KISSAN,
    status: 'posted',
    remaining: '100000.00',
    ...over,
  };
}

const bills = (entries: Record<string, Partial<BillState>>) =>
  new Map(Object.entries(entries).map(([id, b]) => [id, bill(b)]));

describe('allocate()', () => {
  it('Rs 40,000 against a Rs 100,000 bill: all of it on the bill', () => {
    const result = allocate(
      'paid',
      KISSAN,
      '40000',
      [{ billId: 'a', amount: '40000' }],
      bills({ a: {} }),
    );

    expect(result).toEqual({
      allocations: [{ billId: 'a', amount: '40000.00' }],
      allocated: '40000.00',
      advance: '0.00',
      errors: [],
    });
  });

  it('without an amount, a line takes what the bill needs', () => {
    const result = allocate(
      'paid',
      KISSAN,
      '100000',
      [{ billId: 'a' }],
      bills({ a: { remaining: '60000.00' } }),
    );

    expect(result.allocations).toEqual([{ billId: 'a', amount: '60000.00' }]);
    expect(result.advance).toBe('40000.00');
  });

  it('without an amount, a line takes what the payment has left', () => {
    const result = allocate(
      'paid',
      KISSAN,
      '50000',
      [
        { billId: 'a', amount: '30000' },
        { billId: 'b', amount: null },
      ],
      bills({ a: {}, b: {} }),
    );

    expect(result.allocations).toEqual([
      { billId: 'a', amount: '30000.00' },
      { billId: 'b', amount: '20000.00' },
    ]);
    expect(result.advance).toBe('0.00');
  });

  it('settles several bills in list order', () => {
    const result = allocate(
      'received',
      KISSAN,
      '150000.50',
      [{ billId: 'b' }, { billId: 'a' }],
      bills({ a: { remaining: '100000.00' }, b: { remaining: '80000.25' } }),
    );

    expect(result.allocations).toEqual([
      { billId: 'b', amount: '80000.25' },
      { billId: 'a', amount: '70000.25' },
    ]);
    expect(result.allocated).toBe('150000.50');
    expect(result.advance).toBe('0.00');
  });

  it('no bills: all of it is an advance', () => {
    expect(allocate('paid', KISSAN, '25000', [], new Map())).toEqual({
      allocations: [],
      allocated: '0.00',
      advance: '25000.00',
      errors: [],
    });
  });

  it('more than a bill has left is refused at the line amount', () => {
    const result = allocate(
      'paid',
      KISSAN,
      '70000',
      [{ billId: 'a', amount: '60000.01' }],
      bills({ a: { remaining: '60000.00' } }),
    );

    expect(result.errors).toEqual([
      {
        field: 'allocations.0.amount',
        message:
          'Only Rs 60000.00 is left to settle on bill PUR-2026-27-000001',
      },
    ]);
  });

  it('lines adding up to more than the amount are refused', () => {
    const result = allocate(
      'paid',
      KISSAN,
      '50000',
      [
        { billId: 'a', amount: '30000' },
        { billId: 'b', amount: '30000' },
      ],
      bills({ a: {}, b: {} }),
    );

    expect(result.errors).toEqual([
      {
        field: 'allocations.1.amount',
        message: 'Only Rs 20000.00 of the amount is left for this bill',
      },
    ]);
  });

  it('a line with nothing of the amount left is refused', () => {
    const result = allocate(
      'paid',
      KISSAN,
      '30000',
      [{ billId: 'a', amount: '30000' }, { billId: 'b' }],
      bills({ a: {}, b: {} }),
    );

    expect(result.errors).toEqual([
      {
        field: 'allocations.1.amount',
        message: 'Nothing of the amount is left for this bill',
      },
    ]);
  });

  it('refuses unknown, other-trader, cancelled, settled and repeated bills', () => {
    const result = allocate(
      'paid',
      KISSAN,
      '100000',
      [
        { billId: 'missing' },
        { billId: 'other' },
        { billId: 'cancelled' },
        { billId: 'settled' },
        { billId: 'draft' },
        { billId: 'ok', amount: '10' },
        { billId: 'ok', amount: '10' },
      ],
      bills({
        other: { traderId: OTHER },
        cancelled: { status: 'cancelled' },
        settled: { remaining: '0.00', billNo: 'PUR-2026-27-000009' },
        draft: { status: 'draft' },
        ok: {},
      }),
    );

    expect(result.errors).toEqual([
      { field: 'allocations.0.purchaseId', message: 'Bill not found' },
      {
        field: 'allocations.1.purchaseId',
        message: 'This bill is of another trader',
      },
      { field: 'allocations.2.purchaseId', message: 'This bill is cancelled' },
      {
        field: 'allocations.3.purchaseId',
        message: 'Nothing is left to settle on bill PUR-2026-27-000009',
      },
      { field: 'allocations.4.purchaseId', message: 'This bill is not posted' },
      {
        field: 'allocations.6.purchaseId',
        message: 'This bill is already in the list',
      },
    ]);
    expect(result.allocations).toEqual([{ billId: 'ok', amount: '10.00' }]);
  });

  it('a receipt names its errors at saleId', () => {
    const result = allocate(
      'received',
      KISSAN,
      '10',
      [{ billId: 'x' }],
      new Map(),
    );

    expect(result.errors[0].field).toBe('allocations.0.saleId');
  });

  it('works in exact rupees and paisa (no float drift)', () => {
    const result = allocate(
      'paid',
      KISSAN,
      '0.30',
      [
        { billId: 'a', amount: '0.10' },
        { billId: 'b', amount: '0.20' },
      ],
      bills({ a: {}, b: {} }),
    );

    expect(result.allocated).toBe('0.30');
    expect(result.advance).toBe('0.00');
    expect(result.errors).toEqual([]);
  });
});

describe('outstandingOf()', () => {
  it('net − settled on save − allocations', () => {
    expect(
      outstandingOf({
        status: 'posted',
        netAmount: '100000.00',
        settledOnSave: '0.00',
        allocated: '40000.00',
      }),
    ).toBe('60000.00');
    expect(
      outstandingOf({
        status: 'posted',
        netAmount: '97300.00',
        settledOnSave: '7300.00',
        allocated: '90000.00',
      }),
    ).toBe('0.00');
  });

  it('a cancelled bill owes nothing', () => {
    expect(
      outstandingOf({
        status: 'cancelled',
        netAmount: '100000.00',
        settledOnSave: '0',
        allocated: '0',
      }),
    ).toBe('0.00');
  });
});

describe('owedOf() and overpaymentOf()', () => {
  it('a kissan is owed the credit balance; a beopari owes the debit one', () => {
    expect(owedOf('paid', '-100000.00').toFixed(2)).toBe('100000.00');
    expect(owedOf('paid', '5000.00').toFixed(2)).toBe('0.00');
    expect(owedOf('received', '80000.00').toFixed(2)).toBe('80000.00');
    expect(owedOf('received', '-1.00').toFixed(2)).toBe('0.00');
  });

  it('more than owed: the excess; up to it: null', () => {
    expect(overpaymentOf('paid', '120000', '-100000.00')).toBe('20000.00');
    expect(overpaymentOf('paid', '100000', '-100000.00')).toBeNull();
    expect(overpaymentOf('paid', '500', '0')).toBe('500.00');
    expect(overpaymentOf('received', '80000.01', '80000.00')).toBe('0.01');
    expect(overpaymentOf('received', '30000', '80000.00')).toBeNull();
  });
});
