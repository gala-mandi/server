import {
  effectiveCharges,
  SHOP_CHARGE_DEFAULTS,
  type ShopCharges,
} from './effective-charges';

const shop: ShopCharges = {
  defaultCommissionPct: '2.50',
  marketFeePct: '1.00',
  labourPerBag: '20.00',
};
const none = { commissionPct: null, marketFeePct: null, labourPerBag: null };

describe('effectiveCharges()', () => {
  it('nothing set on the commodity → the shop defaults', () => {
    expect(effectiveCharges(none, shop)).toEqual({
      commissionPct: '2.50',
      marketFeePct: '1.00',
      labourPerBag: '20.00',
    });
  });

  it('commodity-specific commission overrides the shop default', () => {
    expect(effectiveCharges({ ...none, commissionPct: '3.00' }, shop)).toEqual({
      commissionPct: '3.00',
      marketFeePct: '1.00',
      labourPerBag: '20.00',
    });
  });

  it('every charge falls back on its own', () => {
    expect(
      effectiveCharges(
        { commissionPct: null, marketFeePct: '0.50', labourPerBag: '35.00' },
        shop,
      ),
    ).toEqual({
      commissionPct: '2.50',
      marketFeePct: '0.50',
      labourPerBag: '35.00',
    });
  });

  it('"0.00" on the commodity is a real override, not "use the default"', () => {
    expect(
      effectiveCharges(
        { commissionPct: '0.00', marketFeePct: '0.00', labourPerBag: '0.00' },
        shop,
      ),
    ).toEqual({
      commissionPct: '0.00',
      marketFeePct: '0.00',
      labourPerBag: '0.00',
    });
  });

  it('a shop without settings uses the column defaults (0)', () => {
    expect(effectiveCharges(none, SHOP_CHARGE_DEFAULTS)).toEqual({
      commissionPct: '0.00',
      marketFeePct: '0.00',
      labourPerBag: '0.00',
    });
  });
});
