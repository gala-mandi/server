import type { TenantScope } from '../../database/tenant-database';
import {
  ledgerChanged,
  ledgerLines,
  postPurchase,
  type PurchaseEffect,
  repostPurchase,
  reversePurchase,
} from './purchase-ledger';

const ID = '33333333-3333-4333-8333-333333333333';
const KISSAN = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const USER = '22222222-2222-4222-8222-222222222222';

const purchase: PurchaseEffect = {
  id: ID,
  billNo: 'PUR-2026-27-000001',
  traderId: KISSAN,
  purchaseDate: '2026-11-06',
  netAmount: '97300.00',
  paidAmount: '0.00',
};

const scope = {} as TenantScope;

function fakeLedger() {
  const calls: { op: 'post' | 'reverse'; arg: unknown }[] = [];
  return {
    calls,
    post: jest.fn((_s: TenantScope, arg: unknown) => {
      calls.push({ op: 'post', arg });
      return Promise.resolve({} as never);
    }),
    reverse: jest.fn((_s: TenantScope, arg: unknown) => {
      calls.push({ op: 'reverse', arg });
      return Promise.resolve([]);
    }),
  };
}

describe('ledgerLines()', () => {
  it('credits the kissan with the net amount, dated on the purchase', () => {
    expect(ledgerLines(purchase, USER)).toEqual([
      {
        traderId: KISSAN,
        sourceType: 'purchase',
        sourceId: ID,
        entryDate: '2026-11-06',
        credit: '97300.00',
        narration: 'Purchase PUR-2026-27-000001',
        userId: USER,
      },
    ]);
  });

  it('an amount paid on the same save is debited back', () => {
    const lines = ledgerLines({ ...purchase, paidAmount: '40000.00' }, USER);

    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({
      traderId: KISSAN,
      sourceType: 'purchase',
      sourceId: ID,
      entryDate: '2026-11-06',
      debit: '40000.00',
      narration: 'Paid on purchase PUR-2026-27-000001',
      userId: USER,
    });
  });
});

describe('ledgerChanged()', () => {
  it.each([
    ['trader', { traderId: OTHER }],
    ['date', { purchaseDate: '2026-11-05' }],
    ['net', { netAmount: '97000.00' }],
    ['paid', { paidAmount: '1.00' }],
  ])('a new %s changes the khata', (_name, change) => {
    expect(ledgerChanged(purchase, { ...purchase, ...change })).toBe(true);
  });

  it('notes or the same amounts written differently do not', () => {
    expect(
      ledgerChanged(purchase, {
        ...purchase,
        netAmount: '97300',
        paidAmount: '0',
      }),
    ).toBe(false);
  });
});

describe('postPurchase()', () => {
  it('posts every line in the given scope', async () => {
    const ledger = fakeLedger();

    await postPurchase(ledger, scope, { ...purchase, paidAmount: '500' }, USER);

    expect(ledger.post).toHaveBeenCalledTimes(2);
    expect(ledger.post.mock.calls.every(([s]) => s === scope)).toBe(true);
  });
});

describe('repostPurchase() (edit)', () => {
  it('reverses the old lines on the old date, then posts the new ones', async () => {
    const ledger = fakeLedger();
    const after = {
      ...purchase,
      purchaseDate: '2026-11-07',
      netAmount: '98000.00',
    };

    expect(await repostPurchase(ledger, scope, purchase, after, USER)).toBe(
      true,
    );

    expect(ledger.calls.map((c) => c.op)).toEqual(['reverse', 'post']);
    expect(ledger.calls[0].arg).toEqual({
      sourceType: 'purchase',
      sourceId: ID,
      narration: 'Purchase PUR-2026-27-000001 edited',
      entryDate: '2026-11-06',
      userId: USER,
    });
    expect(ledger.calls[1].arg).toMatchObject({
      credit: '98000.00',
      entryDate: '2026-11-07',
    });
  });

  it('moving to another kissan: the reversal undoes the old one', async () => {
    const ledger = fakeLedger();

    await repostPurchase(
      ledger,
      scope,
      purchase,
      { ...purchase, traderId: OTHER },
      USER,
    );

    expect(ledger.calls.map((c) => c.op)).toEqual(['reverse', 'post']);
    expect(ledger.calls[1].arg).toMatchObject({ traderId: OTHER });
  });

  it('writes nothing when the khata stays the same', async () => {
    const ledger = fakeLedger();

    expect(
      await repostPurchase(ledger, scope, purchase, { ...purchase }, USER),
    ).toBe(false);
    expect(ledger.calls).toEqual([]);
  });
});

describe('reversePurchase() (cancel)', () => {
  it('reverses the whole purchase, dated today by the khata', async () => {
    const ledger = fakeLedger();

    await reversePurchase(ledger, scope, purchase, USER);

    expect(ledger.calls).toEqual([
      {
        op: 'reverse',
        arg: {
          sourceType: 'purchase',
          sourceId: ID,
          narration: 'Purchase PUR-2026-27-000001 cancelled',
          userId: USER,
        },
      },
    ]);
  });
});
