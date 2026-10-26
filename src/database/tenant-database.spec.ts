import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../common/context/request-context';
import type { Database } from './database.module';
import { auditLogs } from './schema';
import { TenantDatabase } from './tenant-database';

const SHOP = '11111111-1111-4111-8111-111111111111';
const ADMIN = '99999999-9999-4999-8999-999999999999';

const dialect = new PgDialect();

function fakeCls(store: RequestContext | null) {
  return {
    isActive: () => store !== null,
    get: (key: keyof RequestContext): unknown => store?.[key],
  } as unknown as ClsService<RequestContext>;
}

/** A Drizzle stand-in that records what TenantDatabase asks for. */
function fakeDb(tenantRows: { id: string }[] = [{ id: SHOP }]) {
  const executed: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: jest.fn((query: SQL) => {
      executed.push(dialect.sqlToQuery(query));
      return Promise.resolve({ rows: [] });
    }),
  };
  const auditValues = jest.fn<Promise<void>, [unknown]>(() =>
    Promise.resolve(),
  );
  const db = {
    select: jest.fn(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(tenantRows) }),
      }),
    })),
    insert: jest.fn(() => ({ values: auditValues })),
    transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { db, tx, executed, auditValues };
}

function service(store: RequestContext | null, fake = fakeDb()) {
  return new TenantDatabase(fake.db as unknown as Database, fakeCls(store));
}

describe('TenantDatabase', () => {
  describe('tenantId', () => {
    it.each([
      ['no request context', null],
      ['no tenant in the token (super_admin)', { tenantId: null }],
      ['an empty context', {}],
    ])('throws 403 with %s', (_label, store) => {
      expect(() => service(store as RequestContext | null).tenantId).toThrow(
        ForbiddenException,
      );
    });

    it('returns the tenant from the request context', () => {
      expect(service({ tenantId: SHOP }).tenantId).toBe(SHOP);
    });
  });

  describe('transaction()', () => {
    it('throws 403 and never opens a transaction without a tenant', () => {
      const fake = fakeDb();

      expect(() =>
        service({ role: 'super_admin', tenantId: null }, fake).transaction(() =>
          Promise.resolve(),
        ),
      ).toThrow(ForbiddenException);
      expect(fake.db.transaction).not.toHaveBeenCalled();
    });

    it('switches to app_tenant and sets app.tenant_id before running fn', async () => {
      const fake = fakeDb();
      const fn = jest.fn(() => {
        // Both settings are already in place when fn runs.
        expect(fake.executed).toHaveLength(2);
        return Promise.resolve('done');
      });

      await expect(
        service({ tenantId: SHOP, role: 'owner' }, fake).transaction(fn),
      ).resolves.toBe('done');

      expect(fake.executed[0].sql).toBe('set local role app_tenant');
      expect(fake.executed[1].sql).toBe(
        "select set_config('app.tenant_id', $1, true)",
      );
      expect(fake.executed[1].params).toEqual([SHOP]);
      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({ tx: fake.tx, tenantId: SHOP }),
      );
    });
  });

  describe('withTenant()', () => {
    it.each(['owner', 'manager', 'operator', undefined])(
      'throws 403 for role %s and touches nothing',
      async (role) => {
        const fake = fakeDb();
        const fn = jest.fn();

        await expect(
          service(
            { tenantId: SHOP, role: role as RequestContext['role'] },
            fake,
          ).withTenant(SHOP, fn),
        ).rejects.toThrow(ForbiddenException);

        expect(fake.db.select).not.toHaveBeenCalled();
        expect(fake.db.insert).not.toHaveBeenCalled();
        expect(fake.db.transaction).not.toHaveBeenCalled();
        expect(fn).not.toHaveBeenCalled();
      },
    );

    it('throws 404 for an unknown shop and writes nothing', async () => {
      const fake = fakeDb([]);

      await expect(
        service({ role: 'super_admin', userId: ADMIN }, fake).withTenant(
          SHOP,
          jest.fn(),
        ),
      ).rejects.toThrow(NotFoundException);

      expect(fake.db.insert).not.toHaveBeenCalled();
      expect(fake.db.transaction).not.toHaveBeenCalled();
    });

    it('writes the audit row first, then runs fn inside that shop', async () => {
      const fake = fakeDb();
      const fn = jest.fn(() => {
        expect(fake.auditValues).toHaveBeenCalledTimes(1);
        return Promise.resolve('rows');
      });

      await expect(
        service(
          {
            role: 'super_admin',
            userId: ADMIN,
            tenantId: null,
            ip: '10.0.0.1',
          },
          fake,
        ).withTenant(SHOP, fn),
      ).resolves.toBe('rows');

      expect(fake.db.insert).toHaveBeenCalledWith(auditLogs);
      expect(fake.auditValues).toHaveBeenCalledWith({
        tenantId: SHOP,
        userId: ADMIN,
        entity: 'tenant',
        entityId: SHOP,
        action: 'access',
        ip: '10.0.0.1',
      });
      expect(fake.executed[1].params).toEqual([SHOP]);
      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: SHOP }),
      );
    });
  });
});
