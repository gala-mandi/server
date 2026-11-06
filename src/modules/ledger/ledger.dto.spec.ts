import {
  adjustmentSchema,
  balancesQuerySchema,
  statementQuerySchema,
} from './ledger.dto';

const TRADER = '33333333-3333-4333-8333-333333333333';

describe('statementQuerySchema', () => {
  it('has no dates and the first 100 entries by default', () => {
    expect(statementQuerySchema.parse({})).toEqual({ page: 1, limit: 100 });
  });

  it('accepts a range, both ends included', () => {
    expect(
      statementQuerySchema.parse({
        from: '2026-10-01',
        to: '2026-10-31',
        page: '2',
        limit: '50',
      }),
    ).toEqual({ from: '2026-10-01', to: '2026-10-31', page: 2, limit: 50 });
    expect(
      statementQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-01' })
        .success,
    ).toBe(true);
  });

  it('refuses a start after the end', () => {
    const result = statementQuerySchema.safeParse({
      from: '2026-11-01',
      to: '2026-10-31',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['from'],
      message: 'The start date must be on or before the end date',
    });
  });

  it.each(['2026-13-01', '01-10-2026', '2026-02-30', 'yesterday'])(
    'refuses the date "%s"',
    (from) => {
      expect(statementQuerySchema.safeParse({ from }).success).toBe(false);
    },
  );

  it('caps the page size at 500', () => {
    expect(statementQuerySchema.safeParse({ limit: '501' }).success).toBe(
      false,
    );
  });
});

describe('balancesQuerySchema', () => {
  it('sorts by name, 20 per page by default', () => {
    expect(balancesQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
      sort: 'name',
    });
  });

  it('accepts a type and the balance sorts', () => {
    expect(
      balancesQuerySchema.parse({ type: 'kissan', sort: '-balance' }),
    ).toMatchObject({ type: 'kissan', sort: '-balance' });
    expect(balancesQuerySchema.safeParse({ sort: 'phone' }).success).toBe(
      false,
    );
  });
});

describe('adjustmentSchema', () => {
  const valid = {
    traderId: TRADER,
    side: 'credit',
    amount: '1500.50',
    reason: 'Wrong rate on parchi 12',
  };

  it('accepts a debit or credit with a reason', () => {
    expect(adjustmentSchema.parse(valid)).toEqual(valid);
    expect(
      adjustmentSchema.parse({
        ...valid,
        side: 'debit',
        entryDate: '2026-10-05',
      }),
    ).toMatchObject({ side: 'debit', entryDate: '2026-10-05' });
  });

  it('trims the reason', () => {
    expect(
      adjustmentSchema.parse({ ...valid, reason: '  Rounding  ' }).reason,
    ).toBe('Rounding');
  });

  it.each([
    ['no reason', { reason: undefined }],
    ['a blank reason', { reason: '   ' }],
    ['a 501-character reason', { reason: 'x'.repeat(501) }],
  ])('refuses %s', (_, over) => {
    const result = adjustmentSchema.safeParse({ ...valid, ...over });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['reason']);
  });

  it.each(['0', '0.00', '-5', '1.234', '1,000', ''])(
    'refuses the amount "%s"',
    (amount) => {
      expect(adjustmentSchema.safeParse({ ...valid, amount }).success).toBe(
        false,
      );
    },
  );

  it('refuses another side, a bad trader id and extra fields', () => {
    expect(adjustmentSchema.safeParse({ ...valid, side: 'up' }).success).toBe(
      false,
    );
    expect(
      adjustmentSchema.safeParse({ ...valid, traderId: 'x' }).success,
    ).toBe(false);
    expect(
      adjustmentSchema.safeParse({ ...valid, sourceType: 'purchase' }).success,
    ).toBe(false);
  });
});
