import { diffChanges, maskSensitive, REDACTED } from './audit-diff';

describe('maskSensitive()', () => {
  it.each([
    'password',
    'passwordHash',
    'newPassword',
    'refreshToken',
    'accessToken',
    'tokenHash',
    'codeHash',
    'otp',
    'otpCode',
    'secret',
    'clientSecret',
    'PASSWORD',
    'Token',
  ])('redacts %s', (key) => {
    expect(maskSensitive({ [key]: 'Correct-horse-1' })).toEqual({
      [key]: REDACTED,
    });
  });

  it('keeps normal business fields', () => {
    const row = {
      name: 'Ali Traders',
      weight: '400.500',
      amount: '12500.00',
      code: 'WHT',
      phone: '03001234567',
      bags: 12,
      active: true,
      notes: null,
    };

    expect(maskSensitive(row)).toEqual(row);
  });

  it('redacts the value whatever its type (object, array, number)', () => {
    expect(
      maskSensitive({
        secret: { nested: 'x' },
        tokens: ['a', 'b'],
        otp: 123456,
      }),
    ).toEqual({ secret: REDACTED, tokens: REDACTED, otp: REDACTED });
  });

  it('redacts at any depth, inside nested objects and arrays', () => {
    const value = {
      name: 'Shop',
      owner: { name: 'Owner', passwordHash: '$argon2id$v=19$abc' },
      sessions: [
        { device: 'phone', refreshToken: 'r1' },
        { device: 'web', tokenHash: 'h2', meta: { otp: '123456' } },
      ],
    };

    expect(maskSensitive(value)).toEqual({
      name: 'Shop',
      owner: { name: 'Owner', passwordHash: REDACTED },
      sessions: [
        { device: 'phone', refreshToken: REDACTED },
        { device: 'web', tokenHash: REDACTED, meta: { otp: REDACTED } },
      ],
    });
    expect(JSON.stringify(maskSensitive(value))).not.toMatch(
      /argon2|r1|h2|123456/,
    );
  });

  it('does not change the object it was given', () => {
    const value = { password: 'p', nested: { secret: 's' } };

    maskSensitive(value);

    expect(value).toEqual({ password: 'p', nested: { secret: 's' } });
  });

  it('turns Dates into ISO strings, at any depth', () => {
    const at = new Date('2026-10-27T05:30:00.000Z');

    expect(maskSensitive({ createdAt: at, items: [{ at }] })).toEqual({
      createdAt: '2026-10-27T05:30:00.000Z',
      items: [{ at: '2026-10-27T05:30:00.000Z' }],
    });
  });

  it('returns JSON-safe values (undefined → null, bigint → string)', () => {
    expect(maskSensitive(undefined)).toBeNull();
    expect(maskSensitive({ a: undefined, b: 10n })).toEqual({
      a: null,
      b: '10',
    });
    expect(maskSensitive('plain')).toBe('plain');
    expect(maskSensitive(['x', 1, false])).toEqual(['x', 1, false]);
  });
});

describe('diffChanges()', () => {
  const base = {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Wheat',
    weight: '400.000',
    updatedAt: new Date('2026-10-27T05:00:00Z'),
  };

  it('keeps only the fields that changed, old and new side by side', () => {
    expect(diffChanges(base, { ...base, weight: '420.000' })).toEqual({
      before: { weight: '400.000' },
      after: { weight: '420.000' },
    });
  });

  it('lists every changed field', () => {
    expect(
      diffChanges(base, { ...base, name: 'Rice', weight: '1.000' }),
    ).toEqual({
      before: { name: 'Wheat', weight: '400.000' },
      after: { name: 'Rice', weight: '1.000' },
    });
  });

  it('ignores updatedAt', () => {
    const after = { ...base, updatedAt: new Date('2026-10-28T00:00:00Z') };

    expect(diffChanges(base, after)).toBeNull();
    expect(
      diffChanges(base, { ...after, name: 'Rice' })?.after,
    ).not.toHaveProperty('updatedAt');
  });

  it('returns null when nothing changed', () => {
    expect(diffChanges(base, { ...base })).toBeNull();
  });

  it('compares Dates by value', () => {
    const before = { ...base, deletedAt: new Date('2026-01-01T00:00:00Z') };
    const same = { ...before, deletedAt: new Date('2026-01-01T00:00:00Z') };

    expect(diffChanges(before, same)).toBeNull();
    expect(diffChanges(before, { ...before, deletedAt: null })).toEqual({
      before: { deletedAt: '2026-01-01T00:00:00.000Z' },
      after: { deletedAt: null },
    });
  });

  it('treats a missing field as null (added or removed fields)', () => {
    expect(diffChanges({ a: 1 }, { b: 2 })).toEqual({
      before: { a: 1, b: null },
      after: { a: null, b: 2 },
    });
  });

  it('compares nested values by content', () => {
    const before = { tags: ['a', 'b'], meta: { bags: 2 } };

    expect(diffChanges(before, { tags: ['a', 'b'], meta: { bags: 2 } })).toBe(
      null,
    );
    expect(diffChanges(before, { ...before, meta: { bags: 3 } })).toEqual({
      before: { meta: { bags: 2 } },
      after: { meta: { bags: 3 } },
    });
  });

  it('masks sensitive values inside the diff', () => {
    const before = {
      name: 'Old',
      profile: { phone: '0300', secret: 'old-secret' },
    };
    const after = {
      name: 'New',
      profile: { phone: '0301', secret: 'new-secret' },
    };

    const changes = diffChanges(before, after);

    expect(changes).toEqual({
      before: { name: 'Old', profile: { phone: '0300', secret: REDACTED } },
      after: { name: 'New', profile: { phone: '0301', secret: REDACTED } },
    });
    expect(JSON.stringify(changes)).not.toMatch(/old-secret|new-secret/);
  });

  it('never writes a sensitive value next to a changed field', () => {
    const changes = diffChanges(
      { name: 'Old', passwordHash: 'hash-1' },
      { name: 'New', passwordHash: 'hash-2' },
    );

    expect(JSON.stringify(changes)).not.toMatch(/hash-1|hash-2/);
    expect(changes?.after.name).toBe('New');
  });
});

describe('fixes found in review', () => {
  it('logs a change to a secret-only field, with both sides masked', () => {
    expect(diffChanges({ pinHash: 'a' }, { pinHash: 'b' })).toEqual({
      before: { pinHash: '[REDACTED]' },
      after: { pinHash: '[REDACTED]' },
    });
  });

  it.each(['footprint', 'totPrice', 'hashtag', 'shopCode'])(
    'does not mask the ordinary key %s',
    (key) => {
      expect(maskSensitive({ [key]: 'x' })).toEqual({ [key]: 'x' });
    },
  );

  it.each(['otpCode', 'otp_code', 'refresh_token', 'apiSecret', 'passwords'])(
    'masks %s',
    (key) => {
      expect(maskSensitive({ [key]: 'x' })).toEqual({ [key]: '[REDACTED]' });
    },
  );
});
