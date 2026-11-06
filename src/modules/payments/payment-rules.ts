import Decimal from 'decimal.js';
import type { Direction } from './payment-allocation';

/** `tenant_settings.overpayment_action`: advance | block. */
export type OverpaymentAction = 'advance' | 'block';

export const OVERPAYMENT = 'OVERPAYMENT';

/** The text shown with the warning or the block. */
export function overpaymentMessage(
  direction: Direction,
  traderName: string,
  owed: string,
  excess: string,
): string {
  const owes =
    direction === 'paid'
      ? `The shop owes ${traderName} Rs ${new Decimal(owed).toFixed(2)}`
      : `${traderName} owes the shop Rs ${new Decimal(owed).toFixed(2)}`;
  return `${owes}; this ${direction === 'paid' ? 'payment' : 'receipt'} is Rs ${new Decimal(excess).toFixed(2)} more (an advance)`;
}

/** Who may be on each side: kissans are paid, beoparis pay. */
export const TRADER_TYPE = {
  paid: 'kissan',
  received: 'beopari',
} as const satisfies Record<Direction, string>;

export const TRADER_TYPE_MESSAGE: Record<Direction, string> = {
  paid: 'Money is paid to a kissan (farmer); this trader is not one',
  received: 'Money is received from a beopari (buyer); this trader is not one',
};
