import type { payments } from '../../database/schema';
import { paymentSummarySchema } from './payments.dto';
import { splitAllocations, toSummary } from './payments.service';

type PaymentRow = typeof payments.$inferSelect;

const ID = '11111111-1111-4111-8111-111111111111';
const KISSAN = '22222222-2222-4222-8222-222222222222';
const BILL = '33333333-3333-4333-8333-333333333333';

function row(over: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: ID,
    tenantId: '44444444-4444-4444-8444-444444444444',
    createdBy: null,
    createdAt: new Date('2026-11-06T05:00:00.000Z'),
    updatedAt: new Date('2026-11-06T06:00:00.000Z'),
    deletedAt: null,
    voucherNo: 'PAY-2026-27-000001',
    direction: 'paid',
    traderId: KISSAN,
    paymentDate: '2026-11-06',
    amount: '120000.00',
    method: 'cash',
    reference: null,
    notes: null,
    status: 'posted',
    idempotencyKey: 'key-1',
    ...over,
  };
}

describe('toSummary()', () => {
  it('maps a row with its allocated part and advance', () => {
    const summary = toSummary(row(), { id: KISSAN, name: 'Ali' }, '100000.00');

    expect(summary).toEqual({
      id: ID,
      voucherNo: 'PAY-2026-27-000001',
      direction: 'paid',
      paymentDate: '2026-11-06',
      trader: { id: KISSAN, name: 'Ali' },
      amount: '120000.00',
      allocated: '100000.00',
      advance: '20000.00',
      method: 'cash',
      reference: null,
      status: 'posted',
      notes: null,
      createdAt: '2026-11-06T05:00:00.000Z',
      updatedAt: '2026-11-06T06:00:00.000Z',
    });
    expect(summary).not.toHaveProperty('tenantId');
    expect(summary).not.toHaveProperty('idempotencyKey');
    expect(paymentSummarySchema.safeParse(summary).success).toBe(true);
  });
});

describe('splitAllocations()', () => {
  it('a payment settles purchases, a receipt sales', () => {
    expect(
      splitAllocations('paid', [
        { purchaseId: BILL, amount: '5' },
        { saleId: BILL },
      ]),
    ).toEqual({
      requests: [{ billId: BILL, amount: '5' }, null],
      errors: [
        {
          field: 'allocations.1.saleId',
          message: 'A payment settles purchase bills; choose a purchase',
        },
      ],
    });
    expect(splitAllocations('received', [{ purchaseId: BILL }])).toEqual({
      requests: [null],
      errors: [
        {
          field: 'allocations.0.purchaseId',
          message: 'A receipt settles sale bills; choose a sale',
        },
      ],
    });
  });
});
