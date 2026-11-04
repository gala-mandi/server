import { ConflictException, NotFoundException } from '@nestjs/common';
import type { commodities } from '../../database/schema';
import type {
  TenantDatabase,
  TenantScope,
} from '../../database/tenant-database';
import type { RestorableRegistry } from '../audit/restorable-registry';
import { commoditySchema } from './commodities.dto';
import {
  CommoditiesService,
  isNameUniqueViolation,
  toCommodity,
} from './commodities.service';

type CommodityRow = typeof commodities.$inferSelect;

const SHOP = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const CREATED = new Date('2026-11-01T08:00:00.000Z');
const UPDATED = new Date('2026-11-02T09:30:00.000Z');

function row(over: Partial<CommodityRow> = {}): CommodityRow {
  return {
    id: ID,
    tenantId: SHOP,
    createdBy: USER,
    createdAt: CREATED,
    updatedAt: UPDATED,
    deletedAt: null,
    name: 'Gandum',
    nameUr: 'گندم',
    category: 'grain',
    defaultUnit: 'maund',
    bagWeightKg: '100.000',
    commissionPct: '3.00',
    marketFeePct: null,
    labourPerBag: null,
    isActive: true,
    ...over,
  };
}

/** A pg unique violation as node-postgres raises it, wrapped by Drizzle. */
function uniqueViolation(constraint: string): Error {
  const pgError = Object.assign(new Error('duplicate key value'), {
    code: '23505',
    constraint,
  });
  return Object.assign(new Error('Failed query: insert …'), {
    cause: pgError,
  });
}

/** TenantDatabase whose scoped helper is a set of jest mocks. */
function fakeDb() {
  const table = {
    findById: jest.fn((): Promise<CommodityRow | null> =>
      Promise.resolve(row()),
    ),
    insert: jest.fn((values: Partial<CommodityRow>) =>
      Promise.resolve([row(values)]),
    ),
    update: jest.fn(
      (
        _id: string,
        values: Partial<CommodityRow>,
      ): Promise<CommodityRow | null> => Promise.resolve(row(values)),
    ),
    softDelete: jest.fn(() => Promise.resolve(true)),
  };
  const scope = {
    tx: {},
    tenantId: SHOP,
    scoped: () => table,
    audit: jest.fn(),
  } as unknown as TenantScope;
  const db = {
    transaction: jest.fn(<R>(fn: (s: TenantScope) => Promise<R>) => fn(scope)),
  };
  const registry = { register: jest.fn() };
  const service = new CommoditiesService(
    db as unknown as TenantDatabase,
    registry as unknown as RestorableRegistry,
  );
  return { service, table, registry };
}

const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );

describe('toCommodity', () => {
  it('maps a row to the API shape (valid against the response schema)', () => {
    const commodity = toCommodity(row());

    expect(commodity).toEqual({
      id: ID,
      name: 'Gandum',
      nameUr: 'گندم',
      category: 'grain',
      defaultUnit: 'maund',
      bagWeightKg: '100.000',
      commissionPct: '3.00',
      marketFeePct: null,
      labourPerBag: null,
      isActive: true,
      createdAt: '2026-11-01T08:00:00.000Z',
      updatedAt: '2026-11-02T09:30:00.000Z',
    });
    expect(commoditySchema.parse(commodity)).toEqual(commodity);
  });

  it('never exposes tenantId, createdBy or deletedAt', () => {
    const commodity = toCommodity(row({ deletedAt: UPDATED }));

    expect(commodity).not.toHaveProperty('tenantId');
    expect(commodity).not.toHaveProperty('createdBy');
    expect(commodity).not.toHaveProperty('deletedAt');
  });
});

describe('isNameUniqueViolation', () => {
  it('true for the (tenant_id, name) index, wrapped or not', () => {
    expect(
      isNameUniqueViolation(uniqueViolation('commodities_tenant_id_name_key')),
    ).toBe(true);
    expect(
      isNameUniqueViolation({
        code: '23505',
        constraint: 'commodities_tenant_id_name_key',
      }),
    ).toBe(true);
  });

  it('false for other constraints and other errors', () => {
    expect(isNameUniqueViolation(uniqueViolation('users_phone_unique'))).toBe(
      false,
    );
    expect(isNameUniqueViolation(new Error('boom'))).toBe(false);
    expect(isNameUniqueViolation(null)).toBe(false);
    expect(isNameUniqueViolation('23505')).toBe(false);
  });
});

describe('CommoditiesService', () => {
  it('registers commodities as restorable', () => {
    const { service, registry } = fakeDb();

    service.onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(
      'commodities',
      expect.anything(),
    );
  });

  describe('create()', () => {
    const input = {
      name: 'Gandum',
      nameUr: null,
      category: null,
      defaultUnit: 'maund' as const,
      bagWeightKg: null,
      commissionPct: null,
      marketFeePct: null,
      labourPerBag: null,
      isActive: true,
    };

    it('inserts with the shop and the user from the request', async () => {
      const { service, table } = fakeDb();

      await service.create(input, USER);

      expect(table.insert).toHaveBeenCalledWith({
        ...input,
        tenantId: SHOP,
        createdBy: USER,
      });
    });

    it('duplicate name in the shop → 409 NAME_TAKEN on the name field', async () => {
      const { service, table } = fakeDb();
      table.insert.mockRejectedValue(
        uniqueViolation('commodities_tenant_id_name_key'),
      );

      const error = await errorOf(service.create(input, USER));

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        message: 'Another commodity in this shop has this name',
        code: 'NAME_TAKEN',
        errors: [
          {
            field: 'name',
            message: 'Another commodity in this shop has this name',
          },
        ],
      });
    });

    it('any other database error is rethrown unchanged', async () => {
      const { service, table } = fakeDb();
      const boom = uniqueViolation('something_else');
      table.insert.mockRejectedValue(boom);

      await expect(service.create(input, USER)).rejects.toBe(boom);
    });
  });

  describe('update()', () => {
    it('renaming to a name in use → 409 NAME_TAKEN', async () => {
      const { service, table } = fakeDb();
      table.update.mockRejectedValue(
        uniqueViolation('commodities_tenant_id_name_key'),
      );

      const error = await errorOf(service.update(ID, { name: 'Kapas' }));

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'NAME_TAKEN',
        errors: [{ field: 'name' }],
      });
    });

    it('not in this shop → 404', async () => {
      const { service, table } = fakeDb();
      table.update.mockResolvedValue(null);

      await expect(service.update(ID, { name: 'Kapas' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('an empty body writes nothing and returns the row', async () => {
      const { service, table } = fakeDb();

      await expect(service.update(ID, {})).resolves.toMatchObject({ id: ID });
      expect(table.update).not.toHaveBeenCalled();
    });

    it('an empty body for an unknown id → 404', async () => {
      const { service, table } = fakeDb();
      table.findById.mockResolvedValue(null);

      await expect(service.update(ID, {})).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove()', () => {
    it('not used anywhere → soft deleted', async () => {
      const { service, table } = fakeDb();

      await service.remove(ID);

      expect(table.softDelete).toHaveBeenCalledWith(ID);
    });

    it('used in rates, purchases or sales → 409 COMMODITY_IN_USE, not deleted', async () => {
      const { service, table } = fakeDb();
      const isInUse = jest
        .spyOn(
          service as unknown as { isInUse: () => Promise<boolean> },
          'isInUse',
        )
        .mockResolvedValue(true);

      const error = await errorOf(service.remove(ID));

      expect(isInUse).toHaveBeenCalledWith(expect.anything(), ID);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        message:
          'This commodity is used in rates, purchases or sales and cannot be deleted. Deactivate it instead.',
        code: 'COMMODITY_IN_USE',
      });
      expect(table.softDelete).not.toHaveBeenCalled();
    });

    it('not in this shop → 404 before the in-use check', async () => {
      const { service, table } = fakeDb();
      table.findById.mockResolvedValue(null);
      const isInUse = jest.spyOn(
        service as unknown as { isInUse: () => Promise<boolean> },
        'isInUse',
      );

      await expect(service.remove(ID)).rejects.toThrow(NotFoundException);
      expect(isInUse).not.toHaveBeenCalled();
      expect(table.softDelete).not.toHaveBeenCalled();
    });

    it('nothing references commodities yet: isInUse is false today', async () => {
      const { service } = fakeDb();
      const isInUse = (
        service as unknown as {
          isInUse: (s: unknown, id: string) => Promise<boolean>;
        }
      ).isInUse.bind(service);

      await expect(isInUse({}, ID)).resolves.toBe(false);
    });
  });
});
