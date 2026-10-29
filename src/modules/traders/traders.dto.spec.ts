import {
  createTraderSchema,
  listTradersQuerySchema,
  lookupTradersQuerySchema,
  normalizeCnic,
  normalizeTraderPhone,
  updateTraderSchema,
} from './traders.dto';

type Schema =
  | typeof createTraderSchema
  | typeof updateTraderSchema
  | typeof listTradersQuerySchema
  | typeof lookupTradersQuerySchema;

/** Field paths of the issues, e.g. `['phone']` ('' for the object itself). */
const fieldsOf = (schema: Schema, input: unknown) => {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
};

const messagesOf = (schema: Schema, input: unknown) => {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

const base = { type: 'kissan', name: 'Muhammad Ali' };
const create = (over: Record<string, unknown> = {}) =>
  createTraderSchema.safeParse({ ...base, ...over });

describe('normalizeTraderPhone', () => {
  it.each([
    ['+92 300 1234567', '03001234567'],
    ['+923001234567', '03001234567'],
    ['92-300-1234567', '03001234567'],
    ['0300-1234567', '03001234567'],
    ['0300 123 4567', '03001234567'],
    // Landlines and other numbers keep their digits.
    ['042-3576-1234', '04235761234'],
    ['921234567', '921234567'],
  ])('%p → %p', (input, expected) => {
    expect(normalizeTraderPhone(input)).toBe(expected);
  });
});

describe('normalizeCnic', () => {
  it.each([
    ['3520212345671', '35202-1234567-1'],
    ['35202-1234567-1', '35202-1234567-1'],
    ['35202-12345671', '35202-1234567-1'],
  ])('%p → %p', (input, expected) => {
    expect(normalizeCnic(input)).toBe(expected);
  });
});

describe('createTraderSchema', () => {
  it('needs only type and name; everything else gets a default', () => {
    expect(create()).toEqual({
      success: true,
      data: {
        type: 'kissan',
        name: 'Muhammad Ali',
        fatherName: null,
        phone: null,
        cnic: null,
        village: null,
        address: null,
        openingBalance: '0',
        openingBalanceType: 'debit',
        creditLimit: null,
        isActive: true,
        notes: null,
      },
    });
  });

  it('keeps a full valid body, trimmed and normalised', () => {
    const result = create({
      type: 'beopari',
      name: '  Bilal Traders ',
      fatherName: ' Rashid ',
      phone: '+92 300 1234567',
      cnic: '3520212345671',
      village: 'Chak 45',
      address: 'Grain Market, Okara',
      openingBalance: '50000',
      openingBalanceType: 'credit',
      creditLimit: '100000.50',
      isActive: false,
      notes: 'Pays on Friday',
    });

    expect(result).toEqual({
      success: true,
      data: {
        type: 'beopari',
        name: 'Bilal Traders',
        fatherName: 'Rashid',
        phone: '03001234567',
        cnic: '35202-1234567-1',
        village: 'Chak 45',
        address: 'Grain Market, Okara',
        openingBalance: '50000',
        openingBalanceType: 'credit',
        creditLimit: '100000.50',
        isActive: false,
        notes: 'Pays on Friday',
      },
    });
  });

  describe('type', () => {
    it.each(['kissan', 'beopari', 'arhti'])('accepts %p', (type) => {
      expect(create({ type }).success).toBe(true);
    });

    it.each(['farmer', 'KISSAN', '', null, undefined])('refuses %p', (type) => {
      expect(fieldsOf(createTraderSchema, { ...base, type })).toEqual(['type']);
      expect(messagesOf(createTraderSchema, { ...base, type })).toEqual([
        'Choose kissan, beopari or arhti',
      ]);
    });
  });

  describe('name', () => {
    it('is required', () => {
      expect(fieldsOf(createTraderSchema, { type: 'kissan' })).toEqual([
        'name',
      ]);
    });

    it.each(['', ' ', 'A', '  B  '])(
      'refuses %p (under 2 characters)',
      (name) => {
        expect(messagesOf(createTraderSchema, { ...base, name })).toEqual([
          'Enter the name',
        ]);
      },
    );

    it('accepts 2 and 120 characters, refuses 121', () => {
      expect(create({ name: 'Al' }).success).toBe(true);
      expect(create({ name: 'a'.repeat(120) }).success).toBe(true);
      expect(
        messagesOf(createTraderSchema, { ...base, name: 'a'.repeat(121) }),
      ).toEqual(['Use at most 120 characters']);
    });
  });

  describe('optional text (fatherName, village, address, notes)', () => {
    it.each([
      ['fatherName', 120],
      ['village', 80],
      ['address', 500],
      ['notes', 1000],
    ])('%s: empty or blank → null, max %i characters', (field, max) => {
      for (const empty of ['', '   ', null, undefined]) {
        const result = create({ [field]: empty });
        expect(result.success).toBe(true);
        expect(result.data?.[field as 'notes']).toBeNull();
      }
      expect(create({ [field]: 'x'.repeat(max) }).success).toBe(true);
      expect(
        messagesOf(createTraderSchema, {
          ...base,
          [field]: 'x'.repeat(max + 1),
        }),
      ).toEqual([`Use at most ${max} characters`]);
    });

    it('trims the text', () => {
      expect(create({ village: '  Chak 45 ' }).data?.village).toBe('Chak 45');
    });
  });

  describe('phone', () => {
    it.each([
      ['03001234567', '03001234567'],
      ['+92 300 1234567', '03001234567'],
      ['+92-300-1234567', '03001234567'],
      ['  0300 1234567  ', '03001234567'],
      ['042-3576-1234', '04235761234'],
      ['1234567', '1234567'],
    ])('accepts %p and stores %p', (phone, stored) => {
      expect(create({ phone }).data?.phone).toBe(stored);
    });

    it.each(['', '   ', null, undefined])('%p → null', (phone) => {
      const result = create({ phone });
      expect(result.success).toBe(true);
      expect(result.data?.phone).toBeNull();
    });

    it.each([
      'abc',
      '0300-abc-4567',
      '123456', // too short
      '0300 1234567 1234567 12', // too long
      '(0300) 1234567',
      '0300.1234567',
      '+------', // no digits at all
      '0------',
    ])('refuses %p', (phone) => {
      expect(fieldsOf(createTraderSchema, { ...base, phone })).toEqual([
        'phone',
      ]);
      expect(messagesOf(createTraderSchema, { ...base, phone })).toEqual([
        'Enter a valid phone number',
      ]);
    });

    it('refuses a number instead of a string', () => {
      expect(
        fieldsOf(createTraderSchema, { ...base, phone: 3001234567 }),
      ).toEqual(['phone']);
    });
  });

  describe('cnic', () => {
    it.each([
      ['35202-1234567-1', '35202-1234567-1'],
      ['3520212345671', '35202-1234567-1'],
      [' 35202-1234567-1 ', '35202-1234567-1'],
    ])('accepts %p and stores %p', (cnic, stored) => {
      expect(create({ cnic }).data?.cnic).toBe(stored);
    });

    it.each(['', null, undefined])('%p → null', (cnic) => {
      expect(create({ cnic }).data?.cnic).toBeNull();
    });

    it.each([
      '12345-123456-1',
      '12345-12345678-1',
      '352021234567',
      '35202123456712',
      '35202 1234567 1',
      'abcde-fghijkl-m',
    ])('refuses %p', (cnic) => {
      expect(messagesOf(createTraderSchema, { ...base, cnic })).toEqual([
        'Enter the CNIC as 12345-1234567-1',
      ]);
    });
  });

  describe('money (openingBalance, creditLimit)', () => {
    it.each([
      '0',
      '0.00',
      '1',
      '50000',
      '50000.5',
      '50000.50',
      '999999999999.99',
    ])('accepts %p as the same string', (amount) => {
      const result = create({ openingBalance: amount, creditLimit: amount });
      expect(result.data?.openingBalance).toBe(amount);
      expect(result.data?.creditLimit).toBe(amount);
    });

    it.each([
      '-5',
      '1.234',
      '1,000',
      '1e3',
      'abc',
      '',
      '.5',
      '5.',
      '1000000000000',
    ])('refuses %p', (amount) => {
      expect(
        fieldsOf(createTraderSchema, {
          ...base,
          openingBalance: amount,
          creditLimit: amount,
        }),
      ).toEqual(['openingBalance', 'creditLimit']);
      expect(
        messagesOf(createTraderSchema, { ...base, openingBalance: amount })[0],
      ).toBe('Enter an amount in rupees (up to 2 decimals)');
    });

    it('refuses a JS number (no float money)', () => {
      expect(
        fieldsOf(createTraderSchema, {
          ...base,
          openingBalance: 50000,
          creditLimit: 1.5,
        }),
      ).toEqual(['openingBalance', 'creditLimit']);
    });

    it('creditLimit may be null', () => {
      expect(create({ creditLimit: null }).data?.creditLimit).toBeNull();
    });

    it('openingBalance may not be null', () => {
      expect(
        fieldsOf(createTraderSchema, { ...base, openingBalance: null }),
      ).toEqual(['openingBalance']);
    });
  });

  describe('openingBalanceType', () => {
    it.each(['debit', 'credit'])('accepts %p', (t) => {
      expect(create({ openingBalanceType: t }).data?.openingBalanceType).toBe(
        t,
      );
    });

    it.each(['DEBIT', 'dr', '', null])('refuses %p', (t) => {
      expect(
        messagesOf(createTraderSchema, { ...base, openingBalanceType: t }),
      ).toEqual(['Choose debit or credit']);
    });
  });

  describe('isActive', () => {
    it('accepts booleans only', () => {
      expect(create({ isActive: false }).data?.isActive).toBe(false);
      expect(
        fieldsOf(createTraderSchema, { ...base, isActive: 'true' }),
      ).toEqual(['isActive']);
      expect(fieldsOf(createTraderSchema, { ...base, isActive: 1 })).toEqual([
        'isActive',
      ]);
    });
  });

  describe('strict body', () => {
    it.each([
      'tenantId',
      'tenant_id',
      'id',
      'createdBy',
      'balance',
      'deletedAt',
    ])('refuses the unknown key %p', (key) => {
      const result = createTraderSchema.safeParse({ ...base, [key]: 'x' });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({ code: 'unrecognized_keys', keys: [key] }),
      ]);
    });
  });

  it('reports every bad field at once', () => {
    expect(
      fieldsOf(createTraderSchema, {
        type: 'x',
        name: '',
        phone: 'abc',
        cnic: '1',
        openingBalance: '-1',
      }),
    ).toEqual(['type', 'name', 'phone', 'cnic', 'openingBalance']);
  });
});

describe('updateTraderSchema', () => {
  it('accepts an empty body and adds no defaults', () => {
    expect(updateTraderSchema.safeParse({})).toEqual({
      success: true,
      data: {},
    });
  });

  it('keeps only the keys that were sent (no phone/cnic wiped)', () => {
    expect(updateTraderSchema.parse({ name: ' Bilal ' })).toEqual({
      name: 'Bilal',
    });
    expect(updateTraderSchema.parse({ openingBalance: '10' })).toEqual({
      openingBalance: '10',
    });
  });

  it('null or empty clears optional fields', () => {
    expect(
      updateTraderSchema.parse({
        phone: '',
        cnic: null,
        creditLimit: null,
        village: '  ',
      }),
    ).toEqual({ phone: null, cnic: null, creditLimit: null, village: null });
  });

  it('normalises phone and CNIC like create', () => {
    expect(
      updateTraderSchema.parse({
        phone: '+92 321 7654321',
        cnic: '3520212345671',
      }),
    ).toEqual({ phone: '03217654321', cnic: '35202-1234567-1' });
  });

  it('applies the same field rules', () => {
    expect(
      fieldsOf(updateTraderSchema, {
        type: 'farmer',
        name: 'A',
        phone: 'abc',
        cnic: '123',
        openingBalance: '1.234',
        openingBalanceType: 'dr',
        creditLimit: 5,
        isActive: 'no',
      }),
    ).toEqual([
      'type',
      'name',
      'phone',
      'cnic',
      'openingBalance',
      'openingBalanceType',
      'creditLimit',
      'isActive',
    ]);
  });

  it('refuses null for required fields', () => {
    expect(
      fieldsOf(updateTraderSchema, {
        name: null,
        type: null,
        openingBalance: null,
        isActive: null,
      }),
    ).toEqual(['type', 'name', 'openingBalance', 'isActive']);
  });

  it('is strict: tenantId and unknown keys → error', () => {
    expect(fieldsOf(updateTraderSchema, { tenantId: 'x' })).toEqual(['']);
    expect(fieldsOf(updateTraderSchema, { name: 'Bilal', foo: 1 })).toEqual([
      '',
    ]);
  });
});

describe('listTradersQuerySchema', () => {
  it('defaults: page 1, limit 20, sort by name', () => {
    expect(listTradersQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
      sort: 'name',
    });
  });

  it('parses query strings', () => {
    expect(
      listTradersQuerySchema.parse({
        page: '3',
        limit: '100',
        search: '  ali ',
        type: 'beopari',
        active: 'false',
        sort: '-createdAt',
      }),
    ).toEqual({
      page: 3,
      limit: 100,
      search: 'ali',
      type: 'beopari',
      active: false,
      sort: '-createdAt',
    });
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('active=%s → %p', (active, expected) => {
    expect(listTradersQuerySchema.parse({ active }).active).toBe(expected);
  });

  it('no active → undefined (all traders)', () => {
    expect(listTradersQuerySchema.parse({}).active).toBeUndefined();
  });

  it.each(['name', '-name', 'createdAt', '-createdAt'])(
    'accepts sort=%s',
    (sort) => {
      expect(listTradersQuerySchema.parse({ sort }).sort).toBe(sort);
    },
  );

  it.each([
    [{ page: '0' }, 'page'],
    [{ page: '1.5' }, 'page'],
    [{ page: 'x' }, 'page'],
    [{ limit: '0' }, 'limit'],
    [{ limit: '101' }, 'limit'],
    [{ active: 'yes' }, 'active'],
    [{ active: '1' }, 'active'],
    [{ type: 'farmer' }, 'type'],
    [{ sort: 'phone' }, 'sort'],
    [{ search: 'a'.repeat(121) }, 'search'],
  ])('%p → error on %s', (query, field) => {
    expect(fieldsOf(listTradersQuerySchema, query)).toEqual([field]);
  });
});

describe('lookupTradersQuerySchema', () => {
  it('defaults: empty q, limit 10', () => {
    expect(lookupTradersQuerySchema.parse({})).toEqual({ q: '', limit: 10 });
  });

  it('trims q and parses limit and type', () => {
    expect(
      lookupTradersQuerySchema.parse({
        q: ' ali ',
        limit: '50',
        type: 'kissan',
      }),
    ).toEqual({ q: 'ali', limit: 50, type: 'kissan' });
  });

  it.each([
    [{ limit: '0' }, 'limit'],
    [{ limit: '51' }, 'limit'],
    [{ type: 'x' }, 'type'],
    [{ q: 'a'.repeat(121) }, 'q'],
  ])('%p → error on %s', (query, field) => {
    expect(fieldsOf(lookupTradersQuerySchema, query)).toEqual([field]);
  });
});
