import type { purchases } from '../../database/schema';
import { purchaseSummarySchema } from './purchases.dto';
import { isUniqueViolation, roundingOf, toSummary } from './purchases.service';

type PurchaseRow = typeof purchases.$inferSelect;

const SHOP = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const KISSAN = '44444444-4444-4444-8444-444444444444';

function row(over: Partial<PurchaseRow> = {}): PurchaseRow {
  return {
    id: ID,
    tenantId: SHOP,
    createdBy: USER,
    createdAt: new Date('2026-11-06T05:00:00.000Z'),
    updatedAt: new Date('2026-11-06T06:00:00.000Z'),
    deletedAt: null,
    billNo: 'PUR-2026-27-000001',
    traderId: KISSAN,
    purchaseDate: '2026-11-06',
    grossAmount: '100033.30',
    totalDeductions: '2700.84',
    netAmount: '97332.00',
    paidAmount: '0.00',
    status: 'posted',
    notes: null,
    idempotencyKey: 'key-1',
    ...over,
  };
}

describe('roundingOf()', () => {
  it('is net − (gross − deductions), from the stored columns', () => {
    expect(roundingOf(row())).toBe('-0.46');
    expect(
      roundingOf(
        row({
          grossAmount: '100000.00',
          totalDeductions: '2700.00',
          netAmount: '97300.00',
        }),
      ),
    ).toBe('0.00');
    expect(
      roundingOf(
        row({
          grossAmount: '1001.00',
          totalDeductions: '20.02',
          netAmount: '981.00',
        }),
      ),
    ).toBe('0.02');
  });
});

describe('toSummary()', () => {
  it('maps a row to the API shape without tenant or idempotency key', () => {
    const summary = toSummary(row(), { id: KISSAN, name: 'Muhammad Ali' });

    expect(summary).toEqual({
      id: ID,
      billNo: 'PUR-2026-27-000001',
      purchaseDate: '2026-11-06',
      trader: { id: KISSAN, name: 'Muhammad Ali' },
      grossAmount: '100033.30',
      totalDeductions: '2700.84',
      rounding: '-0.46',
      netAmount: '97332.00',
      paidAmount: '0.00',
      status: 'posted',
      notes: null,
      createdAt: '2026-11-06T05:00:00.000Z',
      updatedAt: '2026-11-06T06:00:00.000Z',
    });
    expect(summary).not.toHaveProperty('tenantId');
    expect(summary).not.toHaveProperty('idempotencyKey');
    expect(purchaseSummarySchema.safeParse(summary).success).toBe(true);
  });
});

describe('isUniqueViolation()', () => {
  const pg = {
    code: '23505',
    constraint: 'purchases_tenant_id_idempotency_key_key',
  };

  it('finds the constraint on the error or its cause (Drizzle wraps it)', () => {
    expect(isUniqueViolation(pg, pg.constraint)).toBe(true);
    expect(isUniqueViolation({ cause: pg }, pg.constraint)).toBe(true);
  });

  it('another constraint or error is not it', () => {
    expect(isUniqueViolation(pg, 'purchases_tenant_id_bill_no_key')).toBe(
      false,
    );
    expect(isUniqueViolation({ code: '23503' }, pg.constraint)).toBe(false);
    expect(isUniqueViolation(null, pg.constraint)).toBe(false);
  });
});
