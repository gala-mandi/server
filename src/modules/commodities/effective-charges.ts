import type { ChargeInput } from '../../common/charges/calculate-transaction';
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

/** Charges typed on the entry itself; missing or `null` = not changed. */
export type ManualCharges = {
  [K in keyof EffectiveCharges]?: string | null;
};

/** What a new shop's settings start with (column defaults). */
export const SHOP_CHARGE_DEFAULTS: ShopCharges = {
  defaultCommissionPct: '0.00',
  marketFeePct: '0.00',
  labourPerBag: '0.00',
};

/**
 * The charges that apply: a manual value on the entry wins, then the
 * commodity's own value, then the shop default. "0.00" is a real override
 * (no commission on this item/entry), only `null` falls back.
 */
export function effectiveCharges(
  commodity: CommodityCharges,
  shop: ShopCharges,
  manual: ManualCharges = {},
): EffectiveCharges {
  return {
    commissionPct:
      manual.commissionPct ??
      commodity.commissionPct ??
      shop.defaultCommissionPct,
    marketFeePct:
      manual.marketFeePct ?? commodity.marketFeePct ?? shop.marketFeePct,
    labourPerBag:
      manual.labourPerBag ?? commodity.labourPerBag ?? shop.labourPerBag,
  };
}

/** The standard parchi charges, ready for `calculateTransaction()`. */
export function standardCharges(charges: EffectiveCharges): ChargeInput[] {
  return [
    { type: 'commission', basis: 'percent', value: charges.commissionPct },
    { type: 'market_fee', basis: 'percent', value: charges.marketFeePct },
    { type: 'labour', basis: 'per_bag', value: charges.labourPerBag },
  ];
}
