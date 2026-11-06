import { overpaymentMessage } from './payment-rules';

describe('overpaymentMessage()', () => {
  it('says who owes whom and by how much the payment is over', () => {
    expect(overpaymentMessage('paid', 'Ali', '100000', '20000')).toBe(
      'The shop owes Ali Rs 100000.00; this payment is Rs 20000.00 more (an advance)',
    );
    expect(overpaymentMessage('received', 'Bashir', '0', '500.5')).toBe(
      'Bashir owes the shop Rs 0.00; this receipt is Rs 500.50 more (an advance)',
    );
  });
});
