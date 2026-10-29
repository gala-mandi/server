import type { traders } from '../../database/schema';
import { traderSchema } from './traders.dto';
import { likePattern, toTrader } from './traders.service';

type TraderRow = typeof traders.$inferSelect;

const SHOP = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const CREATED = new Date('2026-10-01T08:00:00.000Z');
const UPDATED = new Date('2026-10-02T09:30:00.000Z');

function row(over: Partial<TraderRow> = {}): TraderRow {
  return {
    id: ID,
    tenantId: SHOP,
    createdBy: USER,
    createdAt: CREATED,
    updatedAt: UPDATED,
    deletedAt: null,
    type: 'kissan',
    name: 'Muhammad Ali',
    fatherName: 'Rashid',
    phone: '03001234567',
    cnic: '35202-1234567-1',
    village: 'Chak 45',
    address: 'Okara',
    openingBalance: '50000.00',
    openingBalanceType: 'credit',
    creditLimit: null,
    isActive: true,
    notes: null,
    ...over,
  };
}

describe('toTrader', () => {
  it('maps a row to the API shape', () => {
    expect(toTrader(row())).toEqual({
      id: ID,
      type: 'kissan',
      name: 'Muhammad Ali',
      fatherName: 'Rashid',
      phone: '03001234567',
      cnic: '35202-1234567-1',
      village: 'Chak 45',
      address: 'Okara',
      openingBalance: '50000.00',
      openingBalanceType: 'credit',
      creditLimit: null,
      isActive: true,
      notes: null,
      createdAt: '2026-10-01T08:00:00.000Z',
      updatedAt: '2026-10-02T09:30:00.000Z',
    });
  });

  it('never exposes tenantId, createdBy or deletedAt', () => {
    const trader = toTrader(row({ deletedAt: UPDATED }));

    expect(trader).not.toHaveProperty('tenantId');
    expect(trader).not.toHaveProperty('createdBy');
    expect(trader).not.toHaveProperty('deletedAt');
  });

  it('keeps money as strings and nulls as null', () => {
    const trader = toTrader(
      row({
        creditLimit: '100000.50',
        phone: null,
        cnic: null,
        fatherName: null,
        village: null,
        address: null,
      }),
    );

    expect(trader.creditLimit).toBe('100000.50');
    expect(trader.openingBalance).toBe('50000.00');
    expect(trader).toMatchObject({
      phone: null,
      cnic: null,
      fatherName: null,
      village: null,
      address: null,
    });
  });

  it('matches the response schema', () => {
    expect(traderSchema.safeParse(toTrader(row())).success).toBe(true);
  });
});

describe('likePattern', () => {
  it.each([
    ['ali', '%ali%'],
    ['', '%%'],
    ['0300', '%0300%'],
    ['50%', '%50\\%%'],
    ['a_b', '%a\\_b%'],
    ['c:\\x', '%c:\\\\x%'],
    ['%_\\', '%\\%\\_\\\\%'],
    ["o'brien", "%o'brien%"],
  ])('%p → %p', (text, pattern) => {
    expect(likePattern(text)).toBe(pattern);
  });

  it('escapes every occurrence, not only the first', () => {
    expect(likePattern('%%__')).toBe('%\\%\\%\\_\\_%');
  });
});
