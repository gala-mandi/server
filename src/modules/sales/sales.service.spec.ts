import type { saleItems, sales } from '../../database/schema';
import { saleItemSchema, saleSummarySchema } from './sales.dto';
import { roundingOf, toItem, toSummary } from './sales.service';

type SaleRow = typeof sales.$inferSelect;
type ItemRow = typeof saleItems.$inferSelect;

const SHOP = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const BEOPARI = '44444444-4444-4444-8444-444444444444';
const WHEAT = '66666666-6666-4666-8666-666666666666';
const LOT = '77777777-7777-4777-8777-777777777777';

function row(over: Partial<SaleRow> = {}): SaleRow {
  return {
    id: ID,
    tenantId: SHOP,
    createdBy: USER,
    createdAt: new Date('2026-11-06T05:00:00.000Z'),
    updatedAt: new Date('2026-11-06T06:00:00.000Z'),
    deletedAt: null,
    billNo: 'SAL-2026-27-000001',
    buyerId: BEOPARI,
    saleDate: '2026-11-06',
    grossAmount: '100033.30',
    totalCharges: '2700.84',
    netAmount: '102734.00',
    receivedAmount: '0.00',
    status: 'posted',
    notes: null,
    idempotencyKey: 'key-1',
    ...over,
  };
}

describe('roundingOf()', () => {
  it('is net − (gross + charges), from the stored columns', () => {
    expect(roundingOf(row())).toBe('-0.14');
    expect(
      roundingOf(
        row({
          grossAmount: '100000.00',
          totalCharges: '2700.00',
          netAmount: '102700.00',
        }),
      ),
    ).toBe('0.00');
    expect(
      roundingOf(
        row({
          grossAmount: '1000.40',
          totalCharges: '0.10',
          netAmount: '1001.00',
        }),
      ),
    ).toBe('0.50');
  });
});

describe('toSummary()', () => {
  it('maps a row to the API shape without tenant or idempotency key', () => {
    const summary = toSummary(row(), { id: BEOPARI, name: 'Bashir' });

    expect(summary).toEqual({
      id: ID,
      billNo: 'SAL-2026-27-000001',
      saleDate: '2026-11-06',
      buyer: { id: BEOPARI, name: 'Bashir' },
      grossAmount: '100033.30',
      totalCharges: '2700.84',
      rounding: '-0.14',
      netAmount: '102734.00',
      receivedAmount: '0.00',
      outstanding: '102734.00',
      status: 'posted',
      notes: null,
      createdAt: '2026-11-06T05:00:00.000Z',
      updatedAt: '2026-11-06T06:00:00.000Z',
    });
    expect(summary).not.toHaveProperty('tenantId');
    expect(summary).not.toHaveProperty('idempotencyKey');
    expect(saleSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('outstanding: net − received on save − vouchers; 0 when cancelled', () => {
    const buyer = { id: BEOPARI, name: 'Bashir' };
    const sale = row({ netAmount: '100000.00', receivedAmount: '10000.00' });

    expect(toSummary(sale, buyer, '40000.00').outstanding).toBe('50000.00');
    expect(
      toSummary({ ...sale, status: 'cancelled' }, buyer, '0').outstanding,
    ).toBe('0.00');
  });
});

describe('toItem()', () => {
  it('keeps the linked lot', () => {
    const item: ItemRow = {
      id: ID,
      tenantId: SHOP,
      createdBy: USER,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      saleId: ID,
      commodityId: WHEAT,
      purchaseItemId: LOT,
      bags: 10,
      weightKg: '1000.000',
      rate: '4000.00',
      rateUnit: 'maund',
      amount: '100000.00',
    };

    const mapped = toItem(item, 'Gandum');

    expect(mapped).toEqual({
      id: ID,
      commodityId: WHEAT,
      commodityName: 'Gandum',
      purchaseItemId: LOT,
      bags: 10,
      weightKg: '1000.000',
      rate: '4000.00',
      rateUnit: 'maund',
      amount: '100000.00',
    });
    expect(saleItemSchema.safeParse(mapped).success).toBe(true);
  });
});
