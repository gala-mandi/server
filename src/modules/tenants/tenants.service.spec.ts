import { ConflictException } from '@nestjs/common';
import type { PgTable } from 'drizzle-orm/pg-core';
import type {
  AuditEntry,
  PlatformDatabase,
  PlatformScope,
} from '../../database/platform-database';
import {
  auditLogs,
  tenantSettings,
  tenants,
  users,
} from '../../database/schema';
import type { PasswordService } from '../auth/password.service';
import type { CreateTenantInput } from './tenants.dto';
import { slugify, temporaryPassword, TenantsService } from './tenants.service';

const SHOP = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-01T00:00:00Z');

const ALPHABET =
  /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]+$/;

describe('temporaryPassword()', () => {
  const samples = Array.from({ length: 200 }, () => temporaryPassword());

  it('is 12 characters by default and honours a custom length', () => {
    expect(samples.every((p) => p.length === 12)).toBe(true);
    expect(temporaryPassword(20)).toHaveLength(20);
  });

  it('never uses look-alike characters (0 O 1 l I)', () => {
    for (const p of samples) {
      expect(p).toMatch(ALPHABET);
      expect(p).not.toMatch(/[0O1lI]/);
    }
  });

  it('always has at least one letter and one digit', () => {
    for (const p of samples) {
      expect(p).toMatch(/[a-z]/i);
      expect(p).toMatch(/\d/);
    }
    // Even when short, where all-letters draws are common.
    for (let i = 0; i < 200; i++) {
      const p = temporaryPassword(2);
      expect(p).toMatch(/^(?=.*\d)(?=.*[a-z]).{2}$/i);
    }
  });

  it('is different each time', () => {
    expect(new Set(samples).size).toBe(samples.length);
  });
});

describe('slugify()', () => {
  it.each([
    ['Haji Grain Traders', 'haji-grain-traders'],
    ['  Al-Madina   Commission Shop!! ', 'al-madina-commission-shop'],
    ['Shop #1 / Okara', 'shop-1-okara'],
    ['---ABC---', 'abc'],
    ['Café', 'cafe'],
  ])('%j → %j', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it('only ever returns lowercase ASCII letters, digits and single dashes', () => {
    for (const name of [
      'Rana & Sons (Pvt.) Ltd.',
      'Ünïcödé Ⓢhop',
      'tab\tand\nnewline',
      'x'.repeat(200),
    ]) {
      expect(slugify(name)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('is at most 60 characters', () => {
    expect(slugify('a'.repeat(200))).toBe('a'.repeat(60));
    expect(slugify('word '.repeat(40)).length).toBeLessThanOrEqual(60);
  });

  it('falls back to "shop" when nothing usable is left', () => {
    expect(slugify('غلہ منڈی')).toBe('shop');
    expect(slugify('!!!')).toBe('shop');
    expect(slugify('')).toBe('shop');
  });

  // BUG tenants.service.ts:64 — the slice runs after the dash trim, so a cut
  // that lands on a separator leaves a trailing dash. Drop `.failing` once fixed.
  it('never ends with a dash when cut at 60 characters', () => {
    expect(slugify(`${'a'.repeat(59)} b`)).toBe('a'.repeat(59));
  });

  // BUG tenants.service.ts:60-62 — NFKD splits "ü" into "u" + a combining mark,
  // which then becomes a dash ("zu-rich"). Drop `.failing` once fixed.
  it('drops accents instead of turning them into dashes', () => {
    expect(slugify('Zürich Grains')).toBe('zurich-grains');
  });
});

/* ------------------------------------------------------------------ */
/* create(): everything in one transaction, nothing returned on error  */
/* ------------------------------------------------------------------ */

type Step =
  | { kind: 'select' }
  | { kind: 'insert'; table: string }
  | { kind: 'audit'; entity: string }
  | { kind: 'commit' }
  | { kind: 'rollback'; error: unknown };

const tableName = (table: PgTable): string =>
  table === tenants
    ? 'tenants'
    : table === users
      ? 'users'
      : table === tenantSettings
        ? 'tenant_settings'
        : table === auditLogs
          ? 'audit_logs'
          : 'unknown';

/**
 * A Drizzle query that can be chained (`.from().where().limit()` …) and
 * awaited; awaiting it resolves (or rejects) with `result()`.
 */
function query(result: () => unknown): unknown {
  const target = function () {};
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') {
        return (
          resolve: (v: unknown) => unknown,
          reject: (e: unknown) => unknown,
        ) => {
          try {
            return Promise.resolve(result()).then(resolve, reject);
          } catch (error) {
            return Promise.reject(error as Error).then(resolve, reject);
          }
        };
      }
      return () => proxy;
    },
  });
  return proxy;
}

interface FakeOptions {
  /** Throws instead of inserting into this table. */
  failInsert?: { table: string; error: Error };
  /** Throws instead of writing the audit row for this entity. */
  failAudit?: { entity: string; error: Error };
  /** What the "owner phone/email taken?" select finds. */
  taken?: { phone: string; email: string | null };
}

const tenantRow = {
  id: SHOP,
  name: 'Haji Grain Traders',
  slug: 'haji-grain-traders',
  ownerName: 'Haji Aslam',
  phone: '04412345678',
  email: null,
  address: null,
  city: 'Okara',
  logoUrl: null,
  status: 'trial' as const,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};
const ownerRow = {
  id: OWNER,
  tenantId: SHOP,
  name: 'Haji Aslam',
  phone: '03001234567',
  email: 'aslam@example.com',
  passwordHash: 'hashed',
  role: 'owner' as const,
  isActive: true,
  mustChangePassword: true,
};

/**
 * PlatformDatabase whose transaction records every step and, like Drizzle,
 * rolls back (and rethrows) when the callback throws.
 */
function fakePlatform(options: FakeOptions = {}) {
  const steps: Step[] = [];
  // select() answers in the order create() asks: phone/email taken?, slug
  // taken?, then detail(): tenant row, owner, user counts.
  const selects: unknown[][] = [
    options.taken ? [options.taken] : [],
    [],
    [tenantRow],
    [ownerRow],
    [{ tenantId: SHOP, n: 1 }],
  ];
  const inserted: Record<string, unknown> = {
    tenants: tenantRow,
    users: ownerRow,
    tenant_settings: { tenantId: SHOP, displayName: tenantRow.name },
  };

  const tx = {
    select: () =>
      query(() => {
        steps.push({ kind: 'select' });
        return selects.shift() ?? [];
      }),
    insert: (table: PgTable) =>
      query(() => {
        const name = tableName(table);
        if (options.failInsert?.table === name) throw options.failInsert.error;
        steps.push({ kind: 'insert', table: name });
        return [inserted[name]];
      }),
  };
  const audit = jest.fn((entry: AuditEntry) => {
    if (options.failAudit?.entity === entry.entity) {
      return Promise.reject(options.failAudit.error);
    }
    steps.push({ kind: 'audit', entity: entry.entity });
    return Promise.resolve();
  });

  const platform = {
    transaction: jest.fn(
      async <R>(fn: (scope: PlatformScope) => Promise<R>): Promise<R> => {
        try {
          const result = await fn({
            tx: tx as unknown as PlatformScope['tx'],
            audit,
          });
          steps.push({ kind: 'commit' });
          return result;
        } catch (error) {
          steps.push({ kind: 'rollback', error });
          throw error;
        }
      },
    ),
  };
  return { platform, steps, audit };
}

function serviceWith(fake: ReturnType<typeof fakePlatform>) {
  const passwords = {
    hash: jest.fn((plain: string) => Promise.resolve(`hash(${plain})`)),
  };
  const service = new TenantsService(
    fake.platform as unknown as PlatformDatabase,
    passwords as unknown as PasswordService,
  );
  return { service, passwords };
}

const input: CreateTenantInput = {
  name: 'Haji Grain Traders',
  city: 'Okara',
  address: null,
  phone: '044 1234 5678',
  email: null,
  owner: {
    name: 'Haji Aslam',
    phone: '+92 300 1234567',
    email: 'Aslam@Example.com',
  },
};

/** A pg unique violation as node-postgres raises it (wrapped by Drizzle). */
function uniqueViolation(constraint: string): Error {
  const pgError = Object.assign(new Error('duplicate key value'), {
    code: '23505',
    constraint,
  });
  return Object.assign(new Error('Failed query: insert …'), {
    cause: pgError,
  });
}

describe('TenantsService.create()', () => {
  it('baseline: tenant, owner and settings plus 3 audit rows, then commit', async () => {
    const fake = fakePlatform();
    const { service, passwords } = serviceWith(fake);

    const result = await service.create(input);

    expect(fake.platform.transaction).toHaveBeenCalledTimes(1);
    expect(fake.steps.filter((s) => s.kind !== 'select')).toEqual([
      { kind: 'insert', table: 'tenants' },
      { kind: 'insert', table: 'users' },
      { kind: 'insert', table: 'tenant_settings' },
      { kind: 'audit', entity: 'tenants' },
      { kind: 'audit', entity: 'users' },
      { kind: 'audit', entity: 'tenant_settings' },
      { kind: 'commit' },
    ]);
    expect(result.temporaryPassword).toMatch(ALPHABET);
    expect(passwords.hash).toHaveBeenCalledWith(result.temporaryPassword);
    expect(result.tenant).toMatchObject({ id: SHOP, status: 'trial' });
  });

  it.each([
    ['the settings insert', { failInsert: { table: 'tenant_settings' } }],
    ['the owner insert', { failInsert: { table: 'users' } }],
    ['the tenants audit row', { failAudit: { entity: 'tenants' } }],
    ['the users audit row', { failAudit: { entity: 'users' } }],
    ['the settings audit row', { failAudit: { entity: 'tenant_settings' } }],
  ])(
    'when %s fails: the transaction rolls back, the error is rethrown and no password is returned',
    async (_label, where) => {
      const boom = new Error('disk full');
      const fake = fakePlatform(
        'failInsert' in where
          ? { failInsert: { ...where.failInsert, error: boom } }
          : { failAudit: { ...where.failAudit, error: boom } },
      );
      const { service } = serviceWith(fake);

      let returned: unknown;
      const promise = service.create(input).then((r) => (returned = r));

      await expect(promise).rejects.toBe(boom);
      expect(returned).toBeUndefined();
      // The error left the transaction callback (so Drizzle rolls back) …
      expect(fake.steps.at(-1)).toEqual({ kind: 'rollback', error: boom });
      expect(fake.steps).not.toContainEqual({ kind: 'commit' });
    },
  );

  it('a failure after the tenant insert stops every later write', async () => {
    const fake = fakePlatform({
      failInsert: { table: 'tenant_settings', error: new Error('x') },
    });
    const { service } = serviceWith(fake);

    await expect(service.create(input)).rejects.toThrow('x');

    expect(fake.steps.filter((s) => s.kind === 'insert')).toEqual([
      { kind: 'insert', table: 'tenants' },
      { kind: 'insert', table: 'users' },
    ]);
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it.each([
    ['users_phone_unique', 'PHONE_TAKEN', 'owner.phone'],
    ['users_email_unique', 'EMAIL_TAKEN', 'owner.email'],
  ])(
    'a racing create that hits %s becomes 409 %s (nothing returned)',
    async (constraint, code, field) => {
      const fake = fakePlatform({
        failInsert: { table: 'users', error: uniqueViolation(constraint) },
      });
      const { service } = serviceWith(fake);

      const error = await service.create(input).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code,
        errors: [{ field }],
      });
      expect(fake.steps).toContainEqual(
        expect.objectContaining({ kind: 'rollback' }),
      );
    },
  );

  it('any other database error is rethrown unchanged', async () => {
    const error = uniqueViolation('some_other_unique');
    const fake = fakePlatform({ failInsert: { table: 'tenants', error } });
    const { service } = serviceWith(fake);

    await expect(service.create(input)).rejects.toBe(error);
  });

  it.each([
    [{ phone: '03001234567', email: null }, 'PHONE_TAKEN'],
    [{ phone: '03119999999', email: 'aslam@example.com' }, 'EMAIL_TAKEN'],
  ])(
    'an owner phone/email already in use (%j) is 409 %s before anything is inserted',
    async (taken, code) => {
      const fake = fakePlatform({ taken });
      const { service } = serviceWith(fake);

      const error = await service.create(input).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code,
      });
      expect(fake.steps.filter((s) => s.kind === 'insert')).toEqual([]);
      expect(fake.audit).not.toHaveBeenCalled();
    },
  );
});
