import type { EffectiveCharges } from './commodities.dto';

/** A commodity's own charges; `null` = not set. */
export interface CommodityCharges {
  commissionPct: string | null;
  marketFeePct: string | null;
  labourPerBag: string | null;
}

/** The shop defaults (`tenant_settings`). */
export interface ShopCharges {
  defaultCommissionPct: string;
  marketFeePct: string;
  labourPerBag: string;
}

/** What a new shop's settings start with (column defaults). */
export const SHOP_CHARGE_DEFAULTS: ShopCharges = {
  defaultCommissionPct: '0.00',
  marketFeePct: '0.00',
  labourPerBag: '0.00',
};

/**
 * The charges that apply to a commodity: its own value when set, else the
 * shop default. "0.00" on the commodity is a real override (no commission
 * on this item), only `null` falls back.
 */
export function effectiveCharges(
  commodity: CommodityCharges,
  shop: ShopCharges,
): EffectiveCharges {
  return {
    commissionPct: commodity.commissionPct ?? shop.defaultCommissionPct,
    marketFeePct: commodity.marketFeePct ?? shop.marketFeePct,
    labourPerBag: commodity.labourPerBag ?? shop.labourPerBag,
  };
}
