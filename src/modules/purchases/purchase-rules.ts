import type { Role } from '../../common/auth/auth-user';
import type { ManualCharges } from '../commodities/effective-charges';

/** Who may edit a purchase of a closed day. */
export const CLOSED_DAY_ROLES: readonly Role[] = ['owner'];

export const DAY_CLOSED_MESSAGE =
  'This day is closed. Only the owner can change its purchases.';

/**
 * A day is closed once it is over: every date before today (Asia/Karachi).
 * There is no day-close step yet, so "closed" is the plain calendar rule.
 * An edit touches the purchase's old date and, when it moves it, the new one;
 * both must be open unless the user is the owner.
 *
 * @param today YYYY-MM-DD in Asia/Karachi
 */
export function mayEditDay(
  role: Role,
  purchaseDate: string,
  newDate: string,
  today: string,
): boolean {
  if (CLOSED_DAY_ROLES.includes(role)) return true;
  return purchaseDate >= today && newDate >= today;
}

/** A saved charge line, as `purchase_charges` holds it. */
export interface SavedCharge {
  type: string;
  basis: string;
  value: string;
}

const STANDARD = {
  commissionPct: { type: 'commission', basis: 'percent' },
  marketFeePct: { type: 'market_fee', basis: 'percent' },
  labourPerBag: { type: 'labour', basis: 'per_bag' },
} as const;

/**
 * The charge rates a saved purchase was made with, as manual charges for a
 * recalculation, so editing (say) a weight keeps the bill's own commission
 * even if the shop's settings changed since. A charge with more than one
 * rate on the bill (items of commodities with different rates) is left out:
 * each item then takes its commodity's current rate.
 */
export function savedRates(charges: readonly SavedCharge[]): ManualCharges {
  const rates: ManualCharges = {};
  for (const [key, { type, basis }] of Object.entries(STANDARD)) {
    const values = new Set(
      charges
        .filter((c) => c.type === type && c.basis === basis)
        .map((c) => c.value),
    );
    if (values.size === 1) {
      rates[key as keyof typeof STANDARD] = [...values][0];
    }
  }
  return rates;
}
