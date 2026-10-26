import { pgTable, varchar } from 'drizzle-orm/pg-core';
import { auditLogs } from '../schema';
import { tenantScoped } from '../tenant-scoped';
import { tenantColumns } from '../tenant-table';
import { REDACTED } from './audit-diff';
import { type AuditActor, auditedScoped } from './audited-scoped';

// The plain scoped helper is replaced by a recording fake: these tests are
// about what gets written to `audit_logs`, not about the SQL of the writes.
jest.mock('../tenant-scoped', () => ({ tenantScoped: jest.fn() }));

const items = pgTable('items', {
  ...tenantColumns(),
  name: varchar('name', { length: 120 }).notNull(),
  secretNote: varchar('secret_note', { length: 120 }),
});

const SHOP = '11111111-1111-4111-8111-111111111111';
const ITEM = '33333333-3333-4333-8333-333333333333';
const ITEM_2 = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';

const actor: AuditActor = {
  userId: USER,
  ip: '10.0.0.7',
  userAgent: 'audit-spec/1.0',
};

type Tx = Parameters<typeof auditedScoped>[0];

function row(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenantId: SHOP,
    createdBy: null,
    createdAt: new Date('2026-10-27T05:00:00Z'),
    updatedAt: new Date('2026-10-27T05:00:00Z'),
    deletedAt: null,
    name: 'Wheat',
    secretNote: 'hidden',
    ...extra,
  };
}

describe('auditedScoped()', () => {
  /** Every call in order: business writes and audit inserts. */
  let calls: string[];
  let audits: Record<string, unknown>[];
  let base: Record<string, jest.Mock>;
  // What each fake call resolves to; set per test.
  let returns: Record<string, unknown>;
  let tx: { insert: jest.Mock };

  const scoped = () => auditedScoped(tx as unknown as Tx, items, SHOP, actor);

  beforeEach(() => {
    calls = [];
    audits = [];
    returns = {
      findById: null,
      insert: [],
      update: [],
      softDelete: [],
      restore: [],
      findMany: [],
    };
    const fn = (name: string) =>
      jest.fn((...args: unknown[]) => {
        calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join()})`);
        return Promise.resolve(returns[name]);
      });
    base = {
      findById: fn('findById'),
      insert: fn('insert'),
      update: fn('update'),
      softDelete: fn('softDelete'),
      restore: fn('restore'),
      findMany: fn('findMany'),
    };
    jest.mocked(tenantScoped).mockReturnValue(base as never);
    tx = {
      insert: jest.fn((table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          expect(table).toBe(auditLogs);
          calls.push(`audit(${String(values.action)})`);
          audits.push(values);
          return Promise.resolve();
        },
      })),
    };
  });

  it('wraps tenantScoped() on the same transaction, table and shop', () => {
    scoped();

    expect(tenantScoped).toHaveBeenCalledWith(tx, items, SHOP);
  });

  it('keeps the plain scoped reads (no audit row)', async () => {
    await scoped().findMany();

    expect(base.findMany).toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  describe('insert()', () => {
    it('returns the rows and logs one create per row, after the write', async () => {
      const rows = [row(ITEM), row(ITEM_2, { name: 'Rice' })];
      returns.insert = rows;

      const result = await scoped().insert([
        { name: 'Wheat' },
        { name: 'Rice' },
      ]);

      expect(result).toBe(rows);
      expect(calls[0]).toMatch(/^insert\(/);
      expect(calls.slice(1)).toEqual(['audit(create)', 'audit(create)']);
      expect(audits.map((a) => a.entityId)).toEqual([ITEM, ITEM_2]);
    });

    it('writes entity, shop and actor; before is null, after is the masked row', async () => {
      returns.insert = [row(ITEM)];

      await scoped().insert({ name: 'Wheat' });

      expect(audits).toHaveLength(1);
      expect(audits[0].after).toMatchObject({
        id: ITEM,
        name: 'Wheat',
        secretNote: REDACTED,
        createdAt: '2026-10-27T05:00:00.000Z',
      });
      expect({ ...audits[0], after: 'checked above' }).toEqual({
        tenantId: SHOP,
        userId: USER,
        entity: 'items',
        entityId: ITEM,
        action: 'create',
        before: null,
        after: 'checked above',
        ip: '10.0.0.7',
        userAgent: 'audit-spec/1.0',
      });
    });

    it('logs nothing when nothing was inserted', async () => {
      await scoped().insert([]);

      expect(audits).toEqual([]);
    });
  });

  describe('update()', () => {
    it('returns the new row and logs only the changed fields', async () => {
      returns.findById = row(ITEM, { name: 'old' });
      const after = row(ITEM, {
        name: 'new',
        updatedAt: new Date('2026-10-28T00:00:00Z'),
      });
      returns.update = [after];

      const result = await scoped().update(ITEM, { name: 'new' });

      expect(result).toBe(after);
      expect(calls).toEqual([
        `findById("${ITEM}")`,
        `update("${ITEM}",{"name":"new"})`,
        'audit(update)',
      ]);
      expect(audits).toEqual([
        expect.objectContaining({
          entity: 'items',
          entityId: ITEM,
          action: 'update',
          before: { name: 'old' },
          after: { name: 'new' },
          userId: USER,
        }),
      ]);
    });

    it('logs nothing when no field changed', async () => {
      returns.findById = row(ITEM);
      returns.update = [
        row(ITEM, { updatedAt: new Date('2026-10-28T00:00:00Z') }),
      ];

      await expect(scoped().update(ITEM, { name: 'Wheat' })).resolves.toEqual(
        expect.objectContaining({ id: ITEM }),
      );

      expect(audits).toEqual([]);
    });

    it('returns null and writes nothing when the id is not in this shop', async () => {
      await expect(scoped().update(ITEM, { name: 'x' })).resolves.toBeNull();

      expect(base.update).not.toHaveBeenCalled();
      expect(audits).toEqual([]);
    });
  });

  describe('softDelete()', () => {
    it('returns true and logs delete with the full masked row', async () => {
      returns.findById = row(ITEM);
      returns.softDelete = [{ id: ITEM }];

      await expect(scoped().softDelete(ITEM)).resolves.toBe(true);

      expect(calls).toEqual([
        `findById("${ITEM}")`,
        `softDelete("${ITEM}")`,
        'audit(delete)',
      ]);
      expect(audits[0]).toMatchObject({
        entity: 'items',
        entityId: ITEM,
        action: 'delete',
        after: null,
        before: {
          id: ITEM,
          tenantId: SHOP,
          name: 'Wheat',
          secretNote: REDACTED,
          deletedAt: null,
        },
      });
    });

    it('returns false and writes nothing for a missing id', async () => {
      await expect(scoped().softDelete(ITEM)).resolves.toBe(false);

      expect(base.softDelete).not.toHaveBeenCalled();
      expect(audits).toEqual([]);
    });
  });

  describe('restore()', () => {
    it('returns the row and logs restore', async () => {
      const restored = row(ITEM);
      returns.restore = [restored];

      await expect(scoped().restore(ITEM)).resolves.toBe(restored);

      expect(calls).toEqual([`restore("${ITEM}")`, 'audit(restore)']);
      expect(audits[0]).toMatchObject({
        entity: 'items',
        entityId: ITEM,
        action: 'restore',
        before: null,
        after: { id: ITEM, name: 'Wheat', secretNote: REDACTED },
        userId: USER,
        ip: '10.0.0.7',
        userAgent: 'audit-spec/1.0',
      });
    });

    it('returns null and writes nothing when there is nothing to restore', async () => {
      await expect(scoped().restore(ITEM)).resolves.toBeNull();

      expect(audits).toEqual([]);
    });
  });

  it('an audit insert failure fails the write (so the transaction rolls back)', async () => {
    returns.insert = [row(ITEM)];
    tx.insert.mockReturnValue({
      values: () => Promise.reject(new Error('audit insert failed')),
    });

    await expect(scoped().insert({ name: 'Wheat' })).rejects.toThrow(
      'audit insert failed',
    );
  });

  it('writes null actor fields when there is no request context', async () => {
    returns.insert = [row(ITEM)];
    const system = auditedScoped(tx as unknown as Tx, items, SHOP, {
      userId: null,
      ip: null,
      userAgent: null,
    });

    await system.insert({ name: 'Wheat' });

    expect(audits[0]).toMatchObject({
      userId: null,
      ip: null,
      userAgent: null,
    });
  });
});
