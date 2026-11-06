import Decimal from 'decimal.js';

/**
 * The same closed-day rule and saved-rate rule as purchases: one rule for
 * every parchi.
 */
export {
  CLOSED_DAY_ROLES,
  mayEditDay,
  type SavedCharge,
  savedRates,
} from '../purchases/purchase-rules';

export const DAY_CLOSED_MESSAGE =
  'This day is closed. Only the owner can change its sales.';

/** `tenant_settings.credit_limit_action`: warn | block. */
export type CreditLimitAction = 'warn' | 'block';

export const CREDIT_LIMIT_EXCEEDED = 'CREDIT_LIMIT_EXCEEDED';

/** The buyer's khata around one save, and their limit. */
export interface CreditCheck {
  /** `traders.credit_limit`; `null` = no limit. */
  creditLimit: string | null;
  /** The buyer's balance (debit − credit) before the save. */
  before: string;
  /** … and after it. */
  after: string;
}

/**
 * A save goes over the limit when it raises what the buyer owes and leaves
 * it above their limit. A save that lowers or keeps the balance (a cancel,
 * a smaller weight, a receipt) is never stopped, so a buyer already over
 * the limit can still be corrected. A limit of 0 means no credit at all.
 */
export function overCreditLimit({
  creditLimit,
  before,
  after,
}: CreditCheck): boolean {
  if (creditLimit === null) return false;
  const balance = new Decimal(after);
  return balance.greaterThan(before) && balance.greaterThan(creditLimit);
}

/** The text shown with a warning or a block. */
export function creditLimitMessage(
  buyerName: string,
  balance: string,
  creditLimit: string,
): string {
  return `${buyerName} would owe Rs ${new Decimal(balance).toFixed(2)}, above the credit limit of Rs ${new Decimal(creditLimit).toFixed(2)}`;
}
