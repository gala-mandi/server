import {
  listRatesQuerySchema,
  MAX_RATES_PER_SAVE,
  rateDateParamSchema,
  saveRatesSchema,
} from './rates.dto';

const GANDUM = '11111111-1111-4111-8111-111111111111';
const KAPAS = '22222222-2222-4222-8222-222222222222';

const rate = (over: Record<string, unknown> = {}) => ({
  commodityId: GANDUM,
  minRate: '4000',
  maxRate: '4200.5',
  ...over,
});

/** Field paths of the errors, e.g. ['rates.0.maxRate']. */
function fieldsOf(schema: { safeParse: (v: unknown) => unknown }, v: unknown) {
  const result = schema.safeParse(v) as {
    success: boolean;
    error?: { issues: { path: PropertyKey[] }[] };
  };
  return result.success
    ? []
    : result.error!.issues.map((i) => i.path.join('.'));
}

describe('saveRatesSchema', () => {
  it('accepts many commodities; unit defaults to maund, avg to null', () => {
    const parsed = saveRatesSchema.parse({
      rates: [
        rate(),
        rate({ commodityId: KAPAS, rateUnit: 'kg', avgRate: '' }),
      ],
    });

    expect(parsed.rates).toEqual([
      { ...rate(), avgRate: null, rateUnit: 'maund' },
      { ...rate({ commodityId: KAPAS }), avgRate: null, rateUnit: 'kg' },
    ]);
  });

  it('min equal to max is fine', () => {
    expect(
      fieldsOf(saveRatesSchema, {
        rates: [rate({ minRate: '4000', maxRate: '4000.00' })],
      }),
    ).toEqual([]);
  });

  it('min > max → error on maxRate (compared as decimals, not text)', () => {
    expect(
      fieldsOf(saveRatesSchema, {
        rates: [rate({ minRate: '900.50', maxRate: '900.5' })],
      }),
    ).toEqual([]);
    expect(
      fieldsOf(saveRatesSchema, {
        rates: [rate({ minRate: '1000', maxRate: '999.99' })],
      }),
    ).toEqual(['rates.0.maxRate']);
  });

  it('rates are rupee strings with up to 2 decimals, never numbers', () => {
    expect(
      fieldsOf(saveRatesSchema, {
        rates: [
          rate({ minRate: 4000 }),
          rate({ commodityId: KAPAS, maxRate: '4200.555', avgRate: '-1' }),
        ],
      }),
    ).toEqual(['rates.0.minRate', 'rates.1.maxRate', 'rates.1.avgRate']);
  });

  it('only maund or kg', () => {
    expect(
      fieldsOf(saveRatesSchema, { rates: [rate({ rateUnit: 'bag' })] }),
    ).toEqual(['rates.0.rateUnit']);
  });

  it('the same commodity twice → error on the second one', () => {
    expect(
      fieldsOf(saveRatesSchema, {
        rates: [rate(), rate({ commodityId: KAPAS }), rate()],
      }),
    ).toEqual(['rates.2.commodityId']);
  });

  it('needs 1 to MAX_RATES_PER_SAVE rates', () => {
    expect(fieldsOf(saveRatesSchema, { rates: [] })).toEqual(['rates']);
    const many = Array.from({ length: MAX_RATES_PER_SAVE + 1 }, () => rate());
    expect(fieldsOf(saveRatesSchema, { rates: many })).toEqual(['rates']);
  });

  it('unknown fields (tenantId, rateDate) are refused', () => {
    expect(
      fieldsOf(saveRatesSchema, {
        rates: [rate({ tenantId: KAPAS })],
      }),
    ).toEqual(['rates.0']);
    expect(
      fieldsOf(saveRatesSchema, { rates: [rate()], tenantId: KAPAS }),
    ).toEqual(['']);
  });

  it('a bad commodity id', () => {
    expect(
      fieldsOf(saveRatesSchema, { rates: [rate({ commodityId: 'x' })] }),
    ).toEqual(['rates.0.commodityId']);
  });
});

describe('rateDateParamSchema', () => {
  it('a calendar date', () => {
    expect(rateDateParamSchema.parse({ date: '2026-11-06' })).toEqual({
      date: '2026-11-06',
    });
    expect(fieldsOf(rateDateParamSchema, { date: '2026-02-30' })).toEqual([
      'date',
    ]);
    expect(fieldsOf(rateDateParamSchema, { date: 'today' })).toEqual(['date']);
  });
});

describe('listRatesQuerySchema', () => {
  it('defaults: page 1, 20 per page, newest day first', () => {
    expect(listRatesQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
      sort: '-rateDate',
    });
  });

  it('filters by commodity and an inclusive date range', () => {
    expect(
      listRatesQuerySchema.parse({
        commodity: GANDUM,
        from: '2026-10-01',
        to: '2026-10-01',
      }),
    ).toMatchObject({
      commodity: GANDUM,
      from: '2026-10-01',
      to: '2026-10-01',
    });
  });

  it('to before from → error on to', () => {
    expect(
      fieldsOf(listRatesQuerySchema, { from: '2026-11-06', to: '2026-11-05' }),
    ).toEqual(['to']);
  });

  it('bad values', () => {
    expect(
      fieldsOf(listRatesQuerySchema, {
        commodity: 'gandum',
        from: '2026-1-1',
        limit: '101',
      }),
    ).toEqual(['limit', 'commodity', 'from']);
  });
});
