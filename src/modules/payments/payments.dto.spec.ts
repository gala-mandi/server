import {
  createPaymentSchema,
  listPaymentsQuerySchema,
  MAX_ALLOCATIONS,
} from './payments.dto';

const BILL = '11111111-1111-4111-8111-111111111111';
const TRADER = '22222222-2222-4222-8222-222222222222';

const body = (over: Record<string, unknown> = {}) => ({
  direction: 'paid',
  traderId: TRADER,
  amount: '40000',
  method: 'cash',
  ...over,
});

const messagesOf = (input: unknown) => {
  const result = createPaymentSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe('createPaymentSchema', () => {
  it('fills the defaults: no bills, no reference or notes', () => {
    expect(createPaymentSchema.parse(body())).toEqual({
      direction: 'paid',
      traderId: TRADER,
      amount: '40000',
      method: 'cash',
      reference: null,
      notes: null,
      allocations: [],
    });
  });

  it('the amount is rupees above 0, as a string', () => {
    expect(messagesOf(body({ amount: '0' }))).toEqual([
      'Enter an amount above 0',
    ]);
    expect(messagesOf(body({ amount: '1.005' }))).toEqual([
      'Enter an amount in rupees (up to 2 decimals)',
    ]);
    expect(messagesOf(body({ amount: 40000 }))).toEqual([
      'Enter an amount in rupees',
    ]);
  });

  it('direction and method come from their lists', () => {
    expect(messagesOf(body({ direction: 'refund' }))).toEqual([
      'Choose paid or received',
    ]);
    expect(messagesOf(body({ method: 'card' }))).toEqual([
      'Choose cash, bank, cheque or online',
    ]);
    for (const method of ['cash', 'bank', 'cheque', 'online']) {
      expect(createPaymentSchema.safeParse(body({ method })).success).toBe(
        true,
      );
    }
  });

  it('an allocation names exactly one bill; its amount is optional', () => {
    expect(
      createPaymentSchema.parse(
        body({
          allocations: [{ purchaseId: BILL }, { saleId: BILL, amount: '5' }],
        }),
      ).allocations,
    ).toEqual([{ purchaseId: BILL }, { saleId: BILL, amount: '5' }]);
    expect(messagesOf(body({ allocations: [{}] }))).toEqual([
      'Choose one bill: a purchase or a sale',
    ]);
    expect(
      messagesOf(body({ allocations: [{ purchaseId: BILL, saleId: BILL }] })),
    ).toEqual(['Choose one bill: a purchase or a sale']);
    expect(
      messagesOf(body({ allocations: [{ purchaseId: BILL, amount: '0.00' }] })),
    ).toEqual(['Enter an amount above 0']);
  });

  it(`takes at most ${MAX_ALLOCATIONS} bills`, () => {
    const allocations = Array.from({ length: MAX_ALLOCATIONS + 1 }, () => ({
      purchaseId: BILL,
    }));
    expect(messagesOf(body({ allocations }))).toEqual([
      `Use at most ${MAX_ALLOCATIONS} bills`,
    ]);
  });

  it('refuses unknown fields such as tenantId or status', () => {
    expect(
      createPaymentSchema.safeParse(body({ tenantId: BILL })).success,
    ).toBe(false);
    expect(
      createPaymentSchema.safeParse(body({ status: 'cancelled' })).success,
    ).toBe(false);
  });

  it('reference is at most 80 characters', () => {
    expect(messagesOf(body({ reference: 'x'.repeat(81) }))).toEqual([
      'Use at most 80 characters',
    ]);
  });
});

describe('listPaymentsQuerySchema', () => {
  it('defaults to page 1 of 20, newest first', () => {
    expect(listPaymentsQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
      sort: '-paymentDate',
    });
  });

  it('from must not be after to', () => {
    expect(
      listPaymentsQuerySchema.safeParse({
        from: '2026-11-06',
        to: '2026-11-01',
      }).success,
    ).toBe(false);
  });
});
