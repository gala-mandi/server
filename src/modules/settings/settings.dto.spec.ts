import { settingsSchema, updateSettingsSchema } from './settings.dto';

const parse = (input: unknown) => updateSettingsSchema.safeParse(input);

/** Field paths of the issues, e.g. `['maundKg']`. */
const fieldsOf = (input: unknown) => {
  const result = parse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
};

const messagesOf = (input: unknown) => {
  const result = parse(input);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe('updateSettingsSchema', () => {
  it('accepts an empty body (every field is optional)', () => {
    expect(parse({})).toEqual({ success: true, data: {} });
  });

  it('accepts a full valid body and keeps decimals as strings', () => {
    const result = parse({
      name: '  Al-Madina Traders ',
      phone: '+92 300 1234567',
      email: 'shop@example.com',
      address: 'Grain Market, Okara',
      city: 'Okara',
      logoUrl: null,
      displayName: 'Al-Madina',
      parchiFooter: 'Thank you',
      defaultCommissionPct: '2.50',
      marketFeePct: '0.5',
      labourPerBag: '15.00',
      defaultUnit: 'maund',
      maundKg: '40',
      language: 'ur',
      billPrefix: 'AM-25/',
      financialYearStart: '2026-07-01',
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      name: 'Al-Madina Traders',
      defaultCommissionPct: '2.50',
      marketFeePct: '0.5',
      labourPerBag: '15.00',
      maundKg: '40',
      financialYearStart: '2026-07-01',
    });
  });

  describe('percentages (defaultCommissionPct, marketFeePct)', () => {
    it.each(['0', '2', '2.5', '2.50', '99.99', '100', '100.0', '100.00'])(
      'accepts %p',
      (value) => {
        expect(parse({ defaultCommissionPct: value }).success).toBe(true);
        expect(parse({ marketFeePct: value }).success).toBe(true);
      },
    );

    it.each(['100.5', '100.01', '101', '-1', '2.555', '1e2', 'abc', '', '.5'])(
      'refuses %p',
      (value) => {
        expect(fieldsOf({ defaultCommissionPct: value })).toEqual([
          'defaultCommissionPct',
        ]);
        expect(fieldsOf({ marketFeePct: value })).toEqual(['marketFeePct']);
      },
    );

    it('says what is expected', () => {
      expect(messagesOf({ defaultCommissionPct: '100.5' })).toEqual([
        'Enter a percentage from 0 to 100 (up to 2 decimals)',
      ]);
    });

    it('refuses a JSON number (decimals travel as strings)', () => {
      expect(fieldsOf({ defaultCommissionPct: 2.5 })).toEqual([
        'defaultCommissionPct',
      ]);
    });

    it('trims spaces', () => {
      expect(parse({ defaultCommissionPct: ' 2.50 ' }).data).toEqual({
        defaultCommissionPct: '2.50',
      });
    });
  });

  describe('money (labourPerBag)', () => {
    it.each(['0', '15', '15.5', '15.00', '999999999999.99'])(
      'accepts %p',
      (value) => {
        expect(parse({ labourPerBag: value }).success).toBe(true);
      },
    );

    it.each(['-5', '1.234', '1234567890123', '15,00', '', 'Rs 15', '15.'])(
      'refuses %p',
      (value) => {
        expect(fieldsOf({ labourPerBag: value })).toEqual(['labourPerBag']);
      },
    );

    it('refuses a JSON number', () => {
      expect(fieldsOf({ labourPerBag: 15 })).toEqual(['labourPerBag']);
    });
  });

  describe('maundKg', () => {
    it.each(['40', '40.000', '37.324', '0.5', '999.999'])(
      'accepts %p',
      (value) => {
        expect(parse({ maundKg: value }).success).toBe(true);
      },
    );

    it.each(['0', '0.0', '0.000', '00'])(
      'refuses %p (must be more than 0)',
      (value) => {
        expect(messagesOf({ maundKg: value })).toEqual([
          'Kg per maund must be more than 0',
        ]);
      },
    );

    it.each(['-40', '1000', '40.0001', 'forty', ''])('refuses %p', (value) => {
      expect(fieldsOf({ maundKg: value })).toContain('maundKg');
    });
  });

  describe('billPrefix', () => {
    it.each(['GM', 'GM-', 'AM-25/', 'a1/b2-c3', '0123456789'])(
      'accepts %p',
      (value) => {
        expect(parse({ billPrefix: value }).data).toEqual({
          billPrefix: value,
        });
      },
    );

    it.each(['GM 1', 'GM_1', 'GM.1', 'جی ایم', 'GM#'])(
      'refuses %p (letters, digits, - or / only)',
      (value) => {
        expect(messagesOf({ billPrefix: value })).toEqual([
          'Use letters, digits, - or / only',
        ]);
      },
    );

    it('refuses more than 10 characters', () => {
      expect(messagesOf({ billPrefix: 'ABCDEFGHIJK' })).toEqual([
        'Use at most 10 characters',
      ]);
    });
  });

  describe('empty values become null', () => {
    it.each(['address', 'city', 'displayName', 'parchiFooter', 'billPrefix'])(
      '%s: "" and "   " → null',
      (field) => {
        expect(parse({ [field]: '' }).data).toEqual({ [field]: null });
        expect(parse({ [field]: '   ' }).data).toEqual({ [field]: null });
        expect(parse({ [field]: null }).data).toEqual({ [field]: null });
      },
    );

    it.each(['email', 'financialYearStart'])(
      '%s: "" and null → null',
      (field) => {
        expect(parse({ [field]: '' }).data).toEqual({ [field]: null });
        expect(parse({ [field]: null }).data).toEqual({ [field]: null });
      },
    );

    it('trims optional text', () => {
      expect(parse({ city: '  Okara  ' }).data).toEqual({ city: 'Okara' });
    });
  });

  describe('logoUrl', () => {
    it('accepts only null (removes the logo)', () => {
      expect(parse({ logoUrl: null }).data).toEqual({ logoUrl: null });
    });

    it.each(['https://evil.example/logo.png', '', 'x'])(
      'refuses %p (a new logo goes through POST /settings/logo)',
      (value) => {
        expect(fieldsOf({ logoUrl: value })).toEqual(['logoUrl']);
      },
    );
  });

  describe('shop profile', () => {
    it('requires a name of at least 2 characters after trimming', () => {
      expect(messagesOf({ name: ' A ' })).toEqual(['Enter the shop name']);
      expect(fieldsOf({ name: 'x'.repeat(121) })).toEqual(['name']);
    });

    it.each(['03001234567', '+92 300 1234567', '0300-1234567'])(
      'accepts phone %p',
      (phone) => {
        expect(parse({ phone }).success).toBe(true);
      },
    );

    it.each(['12345', 'phone', '+92 (300) 1234567', ''])(
      'refuses phone %p',
      (phone) => {
        expect(messagesOf({ phone })).toEqual(['Enter a valid phone number']);
      },
    );

    it('refuses a bad email', () => {
      expect(messagesOf({ email: 'not-an-email' })).toEqual([
        'Enter a valid email',
      ]);
    });
  });

  describe('choices and dates', () => {
    it.each(['kg', 'maund', 'bag'])('defaultUnit %p is allowed', (unit) => {
      expect(parse({ defaultUnit: unit }).success).toBe(true);
    });

    it('refuses another unit', () => {
      expect(messagesOf({ defaultUnit: 'ton' })).toEqual([
        'Choose kg, maund or bag',
      ]);
    });

    it('language is en or ur', () => {
      expect(parse({ language: 'ur' }).success).toBe(true);
      expect(messagesOf({ language: 'pa' })).toEqual([
        'Choose English or Urdu',
      ]);
    });

    it('financialYearStart must be YYYY-MM-DD', () => {
      expect(parse({ financialYearStart: '2026-07-01' }).success).toBe(true);
      expect(messagesOf({ financialYearStart: '01/07/2026' })).toEqual([
        'Enter a date as YYYY-MM-DD',
      ]);
      expect(fieldsOf({ financialYearStart: '2026-02-30' })).toEqual([
        'financialYearStart',
      ]);
    });
  });

  describe('unknown keys (strict schema)', () => {
    // (tenant_id / tenantId never reach the schema over HTTP: the global
    // StripTenantIdMiddleware removes them first, see test/settings.e2e-spec.ts.)
    it.each([
      { foo: 'bar' },
      { tenantId: '11111111-1111-4111-8111-111111111111' },
      { tenant_id: '11111111-1111-4111-8111-111111111111' },
      { status: 'active' },
      { slug: 'other-shop' },
      { updatedAt: '2026-01-01T00:00:00.000Z' },
    ])('refuses %p', (body) => {
      const result = parse({ name: 'Valid Shop', ...body });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({
        code: 'unrecognized_keys',
        keys: Object.keys(body),
      });
    });
  });
});

describe('settingsSchema', () => {
  const settings = {
    name: 'Shop',
    phone: '03001234567',
    email: null,
    address: null,
    city: null,
    logoUrl: null,
    displayName: null,
    parchiFooter: null,
    defaultCommissionPct: '0.00',
    marketFeePct: '0.00',
    labourPerBag: '0.00',
    defaultUnit: 'kg',
    maundKg: '40.000',
    billPrefix: null,
    financialYearStart: null,
    language: 'en',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };

  it('describes the response with the defaults', () => {
    expect(settingsSchema.parse(settings)).toEqual(settings);
  });

  it('needs an ISO timestamp for updatedAt', () => {
    expect(
      settingsSchema.safeParse({ ...settings, updatedAt: 'yesterday' }).success,
    ).toBe(false);
  });
});
