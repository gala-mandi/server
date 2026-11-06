import {
  createSaleSchema,
  listSalesQuerySchema,
  MAX_ITEMS,
  updateSaleSchema,
} from './sales.dto';

const BEOPARI = '44444444-4444-4444-8444-444444444444';
const WHEAT = '66666666-6666-4666-8666-666666666666';
const LOT = '77777777-7777-4777-8777-777777777777';

const item = { commodityId: WHEAT, bags: 10, weightKg: '1000', rate: '4000' };
const valid = { buyerId: BEOPARI, items: [item] };

const fieldsOf = (result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[] }[] };
}) => result.error?.issues.map((i) => i.path.join('.')) ?? [];

describe('createSaleSchema', () => {
  it('fills the defaults: maund rate, no lot, no manual charges, nothing received', () => {
    expect(createSaleSchema.parse(valid)).toEqual({
      buyerId: BEOPARI,
      items: [{ ...item, rateUnit: 'maund', purchaseItemId: null }],
      charges: {},
      receivedAmount: '0',
      notes: null,
    });
  });

  it('takes a lot link and an amount received', () => {
    const parsed = createSaleSchema.parse({
      ...valid,
      items: [{ ...item, purchaseItemId: LOT }],
      receivedAmount: ' 5000.5 ',
    });
    expect(parsed.items[0].purchaseItemId).toBe(LOT);
    expect(parsed.receivedAmount).toBe('5000.5');
  });

  it.each([
    [{ ...valid, items: [] }, 'items'],
    [{ ...valid, items: [{ ...item, weightKg: '0' }] }, 'items.0.weightKg'],
    [{ ...valid, items: [{ ...item, rate: '0' }] }, 'items.0.rate'],
    [
      { ...valid, items: [{ ...item, purchaseItemId: 'lot-1' }] },
      'items.0.purchaseItemId',
    ],
    [{ ...valid, items: [{ ...item, extra: 1 }] }, 'items.0'],
    [{ ...valid, buyerId: 'x' }, 'buyerId'],
    [{ ...valid, traderId: BEOPARI }, ''],
    [{ ...valid, saleDate: '2026-02-30' }, 'saleDate'],
    [{ ...valid, receivedAmount: '-1' }, 'receivedAmount'],
    [{ ...valid, receivedAmount: 100 }, 'receivedAmount'],
    [{ ...valid, charges: { commissionPct: '101' } }, 'charges.commissionPct'],
    [{ ...valid, netAmount: '1' }, ''],
    [{ ...valid, billNo: 'SAL-1' }, ''],
  ])('refuses %j at %s', (body, field) => {
    expect(fieldsOf(createSaleSchema.safeParse(body))).toContain(field);
  });

  it(`takes at most ${MAX_ITEMS} items`, () => {
    const many = Array.from({ length: MAX_ITEMS + 1 }, () => item);
    expect(
      fieldsOf(createSaleSchema.safeParse({ ...valid, items: many })),
    ).toEqual(['items']);
  });
});

describe('updateSaleSchema', () => {
  it('every field is optional; null resets a charge', () => {
    expect(updateSaleSchema.parse({})).toEqual({});
    expect(
      updateSaleSchema.parse({ charges: { commissionPct: null } }),
    ).toEqual({ charges: { commissionPct: null } });
  });

  it('refuses unknown fields', () => {
    expect(updateSaleSchema.safeParse({ status: 'cancelled' }).success).toBe(
      false,
    );
  });
});

describe('listSalesQuerySchema', () => {
  it('defaults: page 1, 20 per page, newest first', () => {
    expect(listSalesQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
      sort: '-saleDate',
    });
  });

  it('filters by buyer, commodity, status and dates', () => {
    expect(
      listSalesQuerySchema.parse({
        buyer: BEOPARI,
        commodity: WHEAT,
        status: 'cancelled',
        from: '2026-11-01',
        to: '2026-11-06',
      }),
    ).toMatchObject({ buyer: BEOPARI, status: 'cancelled' });
  });

  it('refuses a range that ends before it starts, and a bad status', () => {
    expect(
      fieldsOf(
        listSalesQuerySchema.safeParse({
          from: '2026-11-06',
          to: '2026-11-01',
        }),
      ),
    ).toEqual(['from']);
    expect(listSalesQuerySchema.safeParse({ status: 'x' }).success).toBe(false);
    expect(listSalesQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
