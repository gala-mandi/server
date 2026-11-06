import {
  createPurchaseSchema,
  idempotencyKeySchema,
  listPurchasesQuerySchema,
  MAX_ITEMS,
  updatePurchaseSchema,
} from './purchases.dto';

const KISSAN = '44444444-4444-4444-8444-444444444444';
const WHEAT = '66666666-6666-4666-8666-666666666666';

const item = { commodityId: WHEAT, bags: 10, weightKg: '1000', rate: '4000' };
const valid = { traderId: KISSAN, items: [item] };

const fieldsOf = (result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[] }[] };
}) => result.error?.issues.map((i) => i.path.join('.')) ?? [];

describe('createPurchaseSchema', () => {
  it('fills the defaults: maund rate, no manual charges, nothing paid', () => {
    expect(createPurchaseSchema.parse(valid)).toEqual({
      traderId: KISSAN,
      items: [{ ...item, rateUnit: 'maund' }],
      charges: {},
      paidAmount: '0',
      notes: null,
    });
  });

  it('keeps money and weight as strings', () => {
    const parsed = createPurchaseSchema.parse({
      ...valid,
      items: [{ ...item, weightKg: ' 1010.125 ', rate: '4000.50' }],
      paidAmount: '1000.5',
    });
    expect(parsed.items[0]).toMatchObject({
      weightKg: '1010.125',
      rate: '4000.50',
    });
    expect(parsed.paidAmount).toBe('1000.5');
  });

  it.each([
    [{ ...valid, items: [] }, 'items'],
    [{ ...valid, items: [{ ...item, weightKg: '0' }] }, 'items.0.weightKg'],
    [{ ...valid, items: [{ ...item, weightKg: 1000 }] }, 'items.0.weightKg'],
    [
      { ...valid, items: [{ ...item, weightKg: '1.2345' }] },
      'items.0.weightKg',
    ],
    [{ ...valid, items: [{ ...item, rate: '-1' }] }, 'items.0.rate'],
    [{ ...valid, items: [{ ...item, rate: '0' }] }, 'items.0.rate'],
    [{ ...valid, items: [{ ...item, bags: 1.5 }] }, 'items.0.bags'],
    [{ ...valid, items: [{ ...item, rateUnit: 'ton' }] }, 'items.0.rateUnit'],
    [
      { ...valid, items: [{ ...item, commodityId: 'x' }] },
      'items.0.commodityId',
    ],
    [{ ...valid, traderId: 'x' }, 'traderId'],
    [{ ...valid, purchaseDate: '2026-02-30' }, 'purchaseDate'],
    [{ ...valid, paidAmount: '1.234' }, 'paidAmount'],
    [{ ...valid, charges: { commissionPct: '101' } }, 'charges.commissionPct'],
    [{ ...valid, charges: { other: '1' } }, 'charges'],
    [{ ...valid, grossAmount: '1' }, ''],
  ])('refuses %j at %p', (body, field) => {
    const result = createPurchaseSchema.safeParse(body);
    expect(result.success).toBe(false);
    expect(fieldsOf(result)).toContain(field);
  });

  it(`at most ${MAX_ITEMS} items`, () => {
    const result = createPurchaseSchema.safeParse({
      ...valid,
      items: Array.from({ length: MAX_ITEMS + 1 }, () => item),
    });
    expect(fieldsOf(result)).toEqual(['items']);
  });

  it('never lets the client send totals', () => {
    for (const key of ['netAmount', 'billNo', 'status', 'tenantId']) {
      expect(
        createPurchaseSchema.safeParse({ ...valid, [key]: 'x' }).success,
      ).toBe(false);
    }
  });
});

describe('updatePurchaseSchema', () => {
  it('every field is optional; null resets a manual charge', () => {
    expect(updatePurchaseSchema.parse({})).toEqual({});
    expect(
      updatePurchaseSchema.parse({ charges: { commissionPct: null } }),
    ).toEqual({ charges: { commissionPct: null } });
  });

  it('items, when sent, are the whole list', () => {
    expect(fieldsOf(updatePurchaseSchema.safeParse({ items: [] }))).toEqual([
      'items',
    ]);
  });
});

describe('idempotencyKeySchema', () => {
  it.each(['5f0c1a2e-9a7b-4c1d-8e2f-0a1b2c3d4e5f', 'a', 'x'.repeat(64)])(
    'accepts %p',
    (key) => expect(idempotencyKeySchema.safeParse(key).success).toBe(true),
  );

  it.each([undefined, '', '  ', 'x'.repeat(65), 'has space', 'ünï'])(
    'refuses %p',
    (key) => expect(idempotencyKeySchema.safeParse(key).success).toBe(false),
  );
});

describe('listPurchasesQuerySchema', () => {
  it('defaults: page 1 of 20, newest first', () => {
    expect(listPurchasesQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
      sort: '-purchaseDate',
    });
  });

  it('filters by dates, trader, commodity and status', () => {
    expect(
      listPurchasesQuerySchema.parse({
        from: '2026-11-01',
        to: '2026-11-06',
        trader: KISSAN,
        commodity: WHEAT,
        status: 'cancelled',
      }),
    ).toMatchObject({ trader: KISSAN, commodity: WHEAT, status: 'cancelled' });
  });

  it.each([
    [{ from: '2026-11-06', to: '2026-11-01' }, 'from'],
    [{ status: 'deleted' }, 'status'],
    [{ trader: 'x' }, 'trader'],
    [{ sort: 'net' }, 'sort'],
    [{ limit: '101' }, 'limit'],
  ])('refuses %j', (query, field) => {
    expect(fieldsOf(listPurchasesQuerySchema.safeParse(query))).toContain(
      field,
    );
  });
});
