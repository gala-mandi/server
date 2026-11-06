import { mayEditDay, savedRates } from './purchase-rules';

const TODAY = '2026-11-06';
const YESTERDAY = '2026-11-05';

describe('mayEditDay()', () => {
  it('anyone may edit a purchase of today', () => {
    expect(mayEditDay('manager', TODAY, TODAY, TODAY)).toBe(true);
    expect(mayEditDay('operator', TODAY, TODAY, TODAY)).toBe(true);
  });

  it('a closed day (before today) is the owner’s only', () => {
    expect(mayEditDay('manager', YESTERDAY, YESTERDAY, TODAY)).toBe(false);
    expect(mayEditDay('operator', YESTERDAY, YESTERDAY, TODAY)).toBe(false);
    expect(mayEditDay('owner', YESTERDAY, YESTERDAY, TODAY)).toBe(true);
  });

  it('moving a purchase into or out of a closed day counts too', () => {
    expect(mayEditDay('manager', TODAY, YESTERDAY, TODAY)).toBe(false);
    expect(mayEditDay('manager', YESTERDAY, TODAY, TODAY)).toBe(false);
    expect(mayEditDay('owner', TODAY, '2026-10-01', TODAY)).toBe(true);
  });
});

describe('savedRates()', () => {
  it('the bill’s own rates, one per standard charge', () => {
    expect(
      savedRates([
        { type: 'commission', basis: 'percent', value: '2.00' },
        { type: 'market_fee', basis: 'percent', value: '0.50' },
        { type: 'labour', basis: 'per_bag', value: '20.00' },
      ]),
    ).toEqual({
      commissionPct: '2.00',
      marketFeePct: '0.50',
      labourPerBag: '20.00',
    });
  });

  it('leaves out a charge with two rates on the bill', () => {
    expect(
      savedRates([
        { type: 'commission', basis: 'percent', value: '2.00' },
        { type: 'commission', basis: 'percent', value: '3.00' },
        { type: 'labour', basis: 'per_bag', value: '20.00' },
      ]),
    ).toEqual({ labourPerBag: '20.00' });
  });

  it('nothing saved → nothing kept', () => {
    expect(savedRates([])).toEqual({});
  });
});
