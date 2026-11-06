import type { TenantScope } from '../../database/tenant-database';
import {
  ledgerLine,
  type PaymentEffect,
  postPayment,
  reversePayment,
} from './payment-ledger';

const payment: PaymentEffect = {
  id: 'pay-1',
  voucherNo: 'PAY-2026-27-000001',
  direction: 'paid',
  traderId: 'kissan-1',
  paymentDate: '2026-11-05',
  amount: '40000.00',
};
const receipt: PaymentEffect = {
  ...payment,
  id: 'rct-1',
  voucherNo: 'RCT-2026-27-000001',
  direction: 'received',
  traderId: 'beopari-1',
};
const scope = {} as TenantScope;

describe('ledgerLine()', () => {
  it('a payment to a kissan is a debit under source_type payment', () => {
    expect(ledgerLine(payment, 'user-1')).toEqual({
      traderId: 'kissan-1',
      sourceType: 'payment',
      sourceId: 'pay-1',
      entryDate: '2026-11-05',
      userId: 'user-1',
      debit: '40000.00',
      narration: 'Payment PAY-2026-27-000001',
    });
  });

  it('a receipt from a beopari is a credit under source_type receipt', () => {
    expect(ledgerLine(receipt, null)).toEqual({
      traderId: 'beopari-1',
      sourceType: 'receipt',
      sourceId: 'rct-1',
      entryDate: '2026-11-05',
      userId: null,
      credit: '40000.00',
      narration: 'Receipt RCT-2026-27-000001',
    });
  });
});

describe('postPayment() / reversePayment()', () => {
  it('posts the one line, and reverses it (dated today) on cancel', async () => {
    const ledger = { post: jest.fn(), reverse: jest.fn() };

    await postPayment(ledger, scope, payment, 'user-1');
    await reversePayment(ledger, scope, receipt, 'user-2');

    expect(ledger.post).toHaveBeenCalledWith(
      scope,
      ledgerLine(payment, 'user-1'),
    );
    expect(ledger.reverse).toHaveBeenCalledWith(scope, {
      sourceType: 'receipt',
      sourceId: 'rct-1',
      narration: 'Receipt RCT-2026-27-000001 cancelled',
      userId: 'user-2',
    });
  });
});
