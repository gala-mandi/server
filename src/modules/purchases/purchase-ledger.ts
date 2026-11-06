import Decimal from 'decimal.js';
import type { TenantScope } from '../../database/tenant-database';
import type { LedgerService, NewEntry } from '../ledger/ledger.service';

/** What of a purchase reaches the kissan's khata. */
export interface PurchaseEffect {
  id: string;
  billNo: string;
  traderId: string;
  /** YYYY-MM-DD; the entries are dated on it. */
  purchaseDate: string;
  netAmount: string;
  paidAmount: string;
}

type Ledger = Pick<LedgerService, 'post' | 'reverse'>;

/**
 * The khata lines of a purchase, all under `source_type = 'purchase'` and the
 * purchase's id: the kissan is credited with the net amount, and an amount
 * paid on the same save is debited back. Their sum (debit − credit) is
 * `paid − net`, which is what the reconciliation check expects.
 */
export function ledgerLines(
  p: PurchaseEffect,
  userId: string | null,
): NewEntry[] {
  const base = {
    traderId: p.traderId,
    sourceType: 'purchase' as const,
    sourceId: p.id,
    entryDate: p.purchaseDate,
    userId,
  };
  const lines: NewEntry[] = [
    { ...base, credit: p.netAmount, narration: `Purchase ${p.billNo}` },
  ];
  if (!new Decimal(p.paidAmount).isZero()) {
    lines.push({
      ...base,
      debit: p.paidAmount,
      narration: `Paid on purchase ${p.billNo}`,
    });
  }
  return lines;
}

/** Whether an edit changes what the khata must hold. */
export function ledgerChanged(
  before: PurchaseEffect,
  after: PurchaseEffect,
): boolean {
  return (
    before.traderId !== after.traderId ||
    before.purchaseDate !== after.purchaseDate ||
    !new Decimal(before.netAmount).eq(after.netAmount) ||
    !new Decimal(before.paidAmount).eq(after.paidAmount)
  );
}

/** Writes a new purchase's khata lines (inside its save transaction). */
export async function postPurchase(
  ledger: Ledger,
  scope: TenantScope,
  p: PurchaseEffect,
  userId: string | null,
): Promise<void> {
  for (const line of ledgerLines(p, userId)) await ledger.post(scope, line);
}

/**
 * After an edit: reverses the old lines (dated on the old purchase date)
 * and posts the new ones (dated on the new one), so every day's khata keeps
 * matching that day's purchases. Nothing is written when the edit doesn't
 * touch the trader, date, net or paid amount. Returns whether it reposted.
 */
export async function repostPurchase(
  ledger: Ledger,
  scope: TenantScope,
  before: PurchaseEffect,
  after: PurchaseEffect,
  userId: string | null,
): Promise<boolean> {
  if (!ledgerChanged(before, after)) return false;
  await ledger.reverse(scope, {
    sourceType: 'purchase',
    sourceId: before.id,
    narration: `Purchase ${before.billNo} edited`,
    entryDate: before.purchaseDate,
    userId,
  });
  await postPurchase(ledger, scope, after, userId);
  return true;
}

/** Cancel: reverses everything still open, dated today (the cancel day). */
export async function reversePurchase(
  ledger: Ledger,
  scope: TenantScope,
  p: PurchaseEffect,
  userId: string | null,
): Promise<void> {
  await ledger.reverse(scope, {
    sourceType: 'purchase',
    sourceId: p.id,
    narration: `Purchase ${p.billNo} cancelled`,
    userId,
  });
}
