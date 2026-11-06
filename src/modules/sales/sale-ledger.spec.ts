import Decimal from 'decimal.js';
import type { TenantScope } from '../../database/tenant-database';
import {
  ledgerChanged,
  ledgerLines,
  postSale,
  repostSale,
  reverseSale,
  type SaleEffect,
} from './sale-ledger';

const ID = '33333333-3333-4333-8333-333333333333';
const BEOPARI = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const USER = '22222222-2222-4222-8222-222222222222';

const sale: SaleEffect = {
  id: ID,
  billNo: 'SAL-2026-27-000001',
  buyerId: BEOPARI,
  saleDate: '2026-11-06',
  netAmount: '102700.00',
  receivedAmount: '0.00',
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
  it('debits the beopari with the net (receivable), dated on the sale', () => {
    expect(ledgerLines(sale, USER)).toEqual([
      {
        traderId: BEOPARI,
        sourceType: 'sale',
        sourceId: ID,
        entryDate: '2026-11-06',
        debit: '102700.00',
        narration: 'Sale SAL-2026-27-000001',
        userId: USER,
      },
    ]);
  });

  it('an amount received on the same save is credited back, under the sale', () => {
    const lines = ledgerLines({ ...sale, receivedAmount: '50000.00' }, USER);

    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({
      traderId: BEOPARI,
      sourceType: 'sale',
      sourceId: ID,
      entryDate: '2026-11-06',
      credit: '50000.00',
      narration: 'Received on sale SAL-2026-27-000001',
      userId: USER,
    });
  });

  it('the lines add up to net − received (what reconciliation expects)', () => {
    const lines = ledgerLines({ ...sale, receivedAmount: '2700.00' }, USER);
    const sum = lines.reduce(
      (s, l) => s.plus(l.debit ?? 0).minus(l.credit ?? 0),
      new Decimal(0),
    );
    expect(sum.toFixed(2)).toBe('100000.00');
  });
});

describe('ledgerChanged()', () => {
  it.each([
    ['buyer', { buyerId: OTHER }],
    ['date', { saleDate: '2026-11-05' }],
    ['net', { netAmount: '97000.00' }],
    ['received', { receivedAmount: '1.00' }],
  ])('a new %s changes the khata', (_name, change) => {
    expect(ledgerChanged(sale, { ...sale, ...change })).toBe(true);
  });

  it('notes or the same amounts written differently do not', () => {
    expect(
      ledgerChanged(sale, {
        ...sale,
        netAmount: '102700',
        receivedAmount: '0',
      }),
    ).toBe(false);
  });
});

describe('postSale()', () => {
  it('posts every line in the given scope', async () => {
    const ledger = fakeLedger();

    await postSale(ledger, scope, { ...sale, receivedAmount: '500' }, USER);

    expect(ledger.post).toHaveBeenCalledTimes(2);
    expect(ledger.post.mock.calls.every(([s]) => s === scope)).toBe(true);
  });
});

describe('repostSale() (edit)', () => {
  it('reverses the old lines on the old date, then posts the new ones', async () => {
    const ledger = fakeLedger();
    const after = { ...sale, saleDate: '2026-11-07', netAmount: '98000.00' };

    expect(await repostSale(ledger, scope, sale, after, USER)).toBe(true);

    expect(ledger.calls.map((c) => c.op)).toEqual(['reverse', 'post']);
    expect(ledger.calls[0].arg).toEqual({
      sourceType: 'sale',
      sourceId: ID,
      narration: 'Sale SAL-2026-27-000001 edited',
      entryDate: '2026-11-06',
      userId: USER,
    });
    expect(ledger.calls[1].arg).toMatchObject({
      debit: '98000.00',
      entryDate: '2026-11-07',
    });
  });

  it('moving to another beopari: the reversal undoes the old one', async () => {
    const ledger = fakeLedger();

    await repostSale(ledger, scope, sale, { ...sale, buyerId: OTHER }, USER);

    expect(ledger.calls[1].arg).toMatchObject({ traderId: OTHER });
  });

  it('writes nothing when the khata stays the same', async () => {
    const ledger = fakeLedger();

    expect(await repostSale(ledger, scope, sale, { ...sale }, USER)).toBe(
      false,
    );
    expect(ledger.calls).toEqual([]);
  });
});

describe('reverseSale() (cancel)', () => {
  it('reverses the whole sale, dated today by the khata', async () => {
    const ledger = fakeLedger();

    await reverseSale(ledger, scope, sale, USER);

    expect(ledger.calls).toEqual([
      {
        op: 'reverse',
        arg: {
          sourceType: 'sale',
          sourceId: ID,
          narration: 'Sale SAL-2026-27-000001 cancelled',
          userId: USER,
        },
      },
    ]);
  });
});
