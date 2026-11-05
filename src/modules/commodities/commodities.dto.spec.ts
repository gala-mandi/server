import {
  createCommoditySchema,
  listCommoditiesQuerySchema,
  lookupCommoditiesQuerySchema,
  updateCommoditySchema,
} from './commodities.dto';

const ok = (body: unknown) => createCommoditySchema.parse(body);
const fails = (body: unknown) => {
  const result = createCommoditySchema.safeParse(body);
  expect(result.success).toBe(false);
  return result.error!.issues;
};
const fieldsOf = (issues: { path: PropertyKey[] }[]) =>
  issues.map((i) => i.path.join('.'));

describe('createCommoditySchema', () => {
  it('needs only a name; the rest gets a default (charges: shop default)', () => {
    expect(ok({ name: 'Gandum' })).toEqual({
      name: 'Gandum',
      nameUr: null,
      category: null,
      defaultUnit: 'maund',
      bagWeightKg: null,
      commissionPct: null,
      marketFeePct: null,
      labourPerBag: null,
      isActive: true,
    });
  });

  it('keeps a full valid body, trimmed', () => {
    expect(
      ok({
        name: '  Basmati Chawal ',
        nameUr: ' باسمتی چاول ',
        category: ' grain ',
        defaultUnit: 'bag',
        bagWeightKg: '100',
        commissionPct: '3.5',
        marketFeePct: '0.25',
        labourPerBag: '25.50',
        isActive: false,
      }),
    ).toEqual({
      name: 'Basmati Chawal',
      nameUr: 'باسمتی چاول',
      category: 'grain',
      defaultUnit: 'bag',
      bagWeightKg: '100',
      commissionPct: '3.5',
      marketFeePct: '0.25',
      labourPerBag: '25.50',
      isActive: false,
    });
  });

  describe('name', () => {
    it('is required and trimmed before the length check', () => {
      expect(fieldsOf(fails({}))).toEqual(['name']);
      expect(fieldsOf(fails({ name: '   ' }))).toEqual(['name']);
      expect(fieldsOf(fails({ name: ' a ' }))).toEqual(['name']);
    });

    it('accepts 2 and 80 characters, refuses 81', () => {
      expect(ok({ name: 'Ti' }).name).toBe('Ti');
      expect(ok({ name: 'x'.repeat(80) }).name).toHaveLength(80);
      expect(fails({ name: 'x'.repeat(81) })[0].message).toBe(
        'Use at most 80 characters',
      );
    });
  });

  it('nameUr and category: at most 80 / 40 characters, "" → null', () => {
    expect(ok({ name: 'Gandum', nameUr: '', category: '' })).toMatchObject({
      nameUr: null,
      category: null,
    });
    expect(fieldsOf(fails({ name: 'Gandum', nameUr: 'x'.repeat(81) }))).toEqual(
      ['nameUr'],
    );
    expect(
      fieldsOf(fails({ name: 'Gandum', category: 'x'.repeat(41) })),
    ).toEqual(['category']);
  });

  it('defaultUnit: kg, maund or bag only', () => {
    for (const unit of ['kg', 'maund', 'bag']) {
      expect(ok({ name: 'Gandum', defaultUnit: unit }).defaultUnit).toBe(unit);
    }
    expect(fails({ name: 'Gandum', defaultUnit: 'ton' })[0].message).toBe(
      'Choose kg, maund or bag',
    );
  });

  describe('bagWeightKg', () => {
    it.each(['100', '50.5', '99999.999', '0.001', ' 40 '])(
      'accepts %p',
      (w) => {
        expect(ok({ name: 'Gandum', bagWeightKg: w }).bagWeightKg).toBe(
          w.trim(),
        );
      },
    );

    it.each(['0', '0.000', '-1', '100000', '1.2345', 'abc', '1e2'])(
      'refuses %p',
      (w) => {
        expect(fieldsOf(fails({ name: 'Gandum', bagWeightKg: w }))).toEqual([
          'bagWeightKg',
        ]);
      },
    );

    it('says why 0 is refused', () => {
      expect(fails({ name: 'Gandum', bagWeightKg: '0' })[0].message).toBe(
        'Bag weight must be more than 0',
      );
    });

    it('null or "" → not set', () => {
      expect(ok({ name: 'Gandum', bagWeightKg: null }).bagWeightKg).toBeNull();
      expect(ok({ name: 'Gandum', bagWeightKg: '' }).bagWeightKg).toBeNull();
    });

    it('refuses a JS number (weights travel as strings)', () => {
      expect(fieldsOf(fails({ name: 'Gandum', bagWeightKg: 100 }))).toEqual([
        'bagWeightKg',
      ]);
    });
  });

  describe('commissionPct and marketFeePct', () => {
    it.each(['0', '0.5', '2.50', '99.99', '100', '100.00'])(
      'accept %p',
      (p) => {
        expect(
          ok({ name: 'Gandum', commissionPct: p, marketFeePct: p }),
        ).toMatchObject({ commissionPct: p, marketFeePct: p });
      },
    );

    it.each(['100.01', '101', '-1', '1.234', 'abc', '5%'])('refuse %p', (p) => {
      expect(
        fieldsOf(fails({ name: 'Gandum', commissionPct: p, marketFeePct: p })),
      ).toEqual(['commissionPct', 'marketFeePct']);
    });

    it('null or "" → use the shop default', () => {
      expect(
        ok({ name: 'Gandum', commissionPct: '', marketFeePct: null }),
      ).toMatchObject({ commissionPct: null, marketFeePct: null });
    });

    it('refuse a JS number', () => {
      expect(fieldsOf(fails({ name: 'Gandum', commissionPct: 2 }))).toEqual([
        'commissionPct',
      ]);
    });
  });

  describe('labourPerBag', () => {
    it.each(['0', '20', '25.5', '999999999999.99'])('accepts %p', (m) => {
      expect(ok({ name: 'Gandum', labourPerBag: m }).labourPerBag).toBe(m);
    });

    it.each(['-1', '1.234', '1000000000000', 'Rs 20'])('refuses %p', (m) => {
      expect(fails({ name: 'Gandum', labourPerBag: m })[0].message).toBe(
        'Enter an amount in rupees (up to 2 decimals)',
      );
    });
  });

  it('isActive: booleans only', () => {
    expect(fieldsOf(fails({ name: 'Gandum', isActive: 'yes' }))).toEqual([
      'isActive',
    ]);
  });

  it('refuses unknown fields (e.g. createdBy)', () => {
    expect(fails({ name: 'Gandum', createdBy: 'x' })[0].code).toBe(
      'unrecognized_keys',
    );
  });

  it('reports every bad field at once', () => {
    expect(
      fieldsOf(
        fails({
          name: '',
          defaultUnit: 'x',
          bagWeightKg: '0',
          commissionPct: '200',
          labourPerBag: '-1',
        }),
      ),
    ).toEqual([
      'name',
      'defaultUnit',
      'bagWeightKg',
      'commissionPct',
      'labourPerBag',
    ]);
  });
});

describe('updateCommoditySchema', () => {
  it('accepts an empty body and adds no defaults', () => {
    expect(updateCommoditySchema.parse({})).toEqual({});
  });

  it('keeps only the keys that were sent', () => {
    expect(updateCommoditySchema.parse({ commissionPct: '3' })).toEqual({
      commissionPct: '3',
    });
  });

  it('null or "" clears an override (back to the shop default)', () => {
    expect(
      updateCommoditySchema.parse({
        commissionPct: null,
        marketFeePct: '',
        labourPerBag: null,
        bagWeightKg: null,
      }),
    ).toEqual({
      commissionPct: null,
      marketFeePct: null,
      labourPerBag: null,
      bagWeightKg: null,
    });
  });

  it('applies the same field rules', () => {
    const result = updateCommoditySchema.safeParse({
      name: 'x',
      defaultUnit: 'ton',
      bagWeightKg: '0',
    });
    expect(result.success).toBe(false);
    expect(fieldsOf(result.error!.issues)).toEqual([
      'name',
      'defaultUnit',
      'bagWeightKg',
    ]);
  });

  it('refuses null for required fields', () => {
    const result = updateCommoditySchema.safeParse({
      name: null,
      defaultUnit: null,
      isActive: null,
    });
    expect(fieldsOf(result.error!.issues)).toEqual([
      'name',
      'defaultUnit',
      'isActive',
    ]);
  });

  it('is strict too', () => {
    expect(updateCommoditySchema.safeParse({ tenantId: 'x' }).success).toBe(
      false,
    );
  });
});

describe('listCommoditiesQuerySchema', () => {
  it('defaults: page 1, limit 20, sorted by name', () => {
    expect(listCommoditiesQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
      sort: 'name',
    });
  });

  it('reads query strings', () => {
    expect(
      listCommoditiesQuerySchema.parse({
        page: '2',
        limit: '5',
        search: ' gan ',
        category: ' grain ',
        active: 'false',
        sort: '-createdAt',
      }),
    ).toEqual({
      page: 2,
      limit: 5,
      search: 'gan',
      category: 'grain',
      active: false,
      sort: '-createdAt',
    });
    expect(listCommoditiesQuerySchema.parse({ active: 'true' }).active).toBe(
      true,
    );
  });

  it.each([
    { page: '0' },
    { limit: '101' },
    { active: 'yes' },
    { sort: 'price' },
  ])('refuses %j', (query) => {
    expect(listCommoditiesQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('lookupCommoditiesQuerySchema', () => {
  it('defaults: no q, limit 10', () => {
    expect(lookupCommoditiesQuerySchema.parse({})).toEqual({
      q: '',
      limit: 10,
    });
  });

  it('limit 1–50', () => {
    expect(lookupCommoditiesQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(
      lookupCommoditiesQuerySchema.safeParse({ limit: '51' }).success,
    ).toBe(false);
    expect(lookupCommoditiesQuerySchema.safeParse({ limit: '0' }).success).toBe(
      false,
    );
  });
});
