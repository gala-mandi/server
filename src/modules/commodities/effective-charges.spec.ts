import {
  effectiveCharges,
  SHOP_CHARGE_DEFAULTS,
  standardCharges,
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

  describe('manual override on the entry', () => {
    const commodity = {
      commissionPct: '3.00',
      marketFeePct: null,
      labourPerBag: '35.00',
    };

    it('each source wins in turn: manual → commodity → shop', () => {
      expect(
        effectiveCharges(commodity, shop, { labourPerBag: '15.00' }),
      ).toEqual({
        commissionPct: '3.00', // commodity
        marketFeePct: '1.00', // shop
        labourPerBag: '15.00', // manual
      });
    });

    it('manual beats both the commodity and the shop default', () => {
      expect(
        effectiveCharges(commodity, shop, {
          commissionPct: '1.50',
          marketFeePct: '0.25',
          labourPerBag: '10.00',
        }),
      ).toEqual({
        commissionPct: '1.50',
        marketFeePct: '0.25',
        labourPerBag: '10.00',
      });
    });

    it('manual "0.00" waives the charge; null or missing falls back', () => {
      expect(
        effectiveCharges(commodity, shop, {
          commissionPct: '0.00',
          marketFeePct: null,
        }),
      ).toEqual({
        commissionPct: '0.00',
        marketFeePct: '1.00',
        labourPerBag: '35.00',
      });
    });
  });
});

describe('standardCharges()', () => {
  it('commission and market fee are percent, labour is per bag', () => {
    expect(
      standardCharges({
        commissionPct: '2.00',
        marketFeePct: '0.50',
        labourPerBag: '20.00',
      }),
    ).toEqual([
      { type: 'commission', basis: 'percent', value: '2.00' },
      { type: 'market_fee', basis: 'percent', value: '0.50' },
      { type: 'labour', basis: 'per_bag', value: '20.00' },
    ]);
  });
});
