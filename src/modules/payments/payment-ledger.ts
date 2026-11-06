import type { TenantScope } from '../../database/tenant-database';
import type { LedgerService, NewEntry } from '../ledger/ledger.service';
import type { Direction } from './payment-allocation';

/** What of a payment reaches the trader's khata. */
export interface PaymentEffect {
  id: string;
  voucherNo: string;
  direction: Direction;
  traderId: string;
  /** YYYY-MM-DD; the entry is dated on it. */
  paymentDate: string;
  amount: string;
}

type Ledger = Pick<LedgerService, 'post' | 'reverse'>;

/** `ledger_entries.source_type` of each direction. */
export const SOURCE_TYPE = {
  paid: 'payment',
  received: 'receipt',
} as const satisfies Record<Direction, NewEntry['sourceType']>;

/**
 * The one khata line of a payment: money paid to a kissan is a debit (the
 * shop owes them less), money received from a beopari a credit (they owe
 * less). Allocations and advances don't change it: the khata holds the
 * whole amount either way.
 */
export function ledgerLine(p: PaymentEffect, userId: string | null): NewEntry {
  const paid = p.direction === 'paid';
  return {
    traderId: p.traderId,
    sourceType: SOURCE_TYPE[p.direction],
    sourceId: p.id,
    entryDate: p.paymentDate,
    userId,
    ...(paid ? { debit: p.amount } : { credit: p.amount }),
    narration: `${paid ? 'Payment' : 'Receipt'} ${p.voucherNo}`,
  };
}

/** Writes a new payment's khata line (inside its save transaction). */
export async function postPayment(
  ledger: Ledger,
  scope: TenantScope,
  p: PaymentEffect,
  userId: string | null,
): Promise<void> {
  await ledger.post(scope, ledgerLine(p, userId));
}

/** Cancel: reverses the line, dated today (the cancel day). */
export async function reversePayment(
  ledger: Ledger,
  scope: TenantScope,
  p: PaymentEffect,
  userId: string | null,
): Promise<void> {
  await ledger.reverse(scope, {
    sourceType: SOURCE_TYPE[p.direction],
    sourceId: p.id,
    narration: `${p.direction === 'paid' ? 'Payment' : 'Receipt'} ${p.voucherNo} cancelled`,
    userId,
  });
}
