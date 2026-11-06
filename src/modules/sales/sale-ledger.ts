import Decimal from 'decimal.js';
import type { TenantScope } from '../../database/tenant-database';
import type { LedgerService, NewEntry } from '../ledger/ledger.service';

/** What of a sale reaches the beopari's khata. */
export interface SaleEffect {
  id: string;
  billNo: string;
  buyerId: string;
  /** YYYY-MM-DD; the entries are dated on it. */
  saleDate: string;
  netAmount: string;
  receivedAmount: string;
}

type Ledger = Pick<LedgerService, 'post' | 'reverse'>;

/**
 * The khata lines of a sale, all under `source_type = 'sale'` and the sale's
 * id: the beopari is debited with the net (receivable) amount, and an amount
 * received on the same save is credited back. Their sum (debit − credit) is
 * `net − received`, which is what the reconciliation check expects.
 */
export function ledgerLines(s: SaleEffect, userId: string | null): NewEntry[] {
  const base = {
    traderId: s.buyerId,
    sourceType: 'sale' as const,
    sourceId: s.id,
    entryDate: s.saleDate,
    userId,
  };
  const lines: NewEntry[] = [
    { ...base, debit: s.netAmount, narration: `Sale ${s.billNo}` },
  ];
  if (!new Decimal(s.receivedAmount).isZero()) {
    lines.push({
      ...base,
      credit: s.receivedAmount,
      narration: `Received on sale ${s.billNo}`,
    });
  }
  return lines;
}

/** Whether an edit changes what the khata must hold. */
export function ledgerChanged(before: SaleEffect, after: SaleEffect): boolean {
  return (
    before.buyerId !== after.buyerId ||
    before.saleDate !== after.saleDate ||
    !new Decimal(before.netAmount).eq(after.netAmount) ||
    !new Decimal(before.receivedAmount).eq(after.receivedAmount)
  );
}

/** Writes a new sale's khata lines (inside its save transaction). */
export async function postSale(
  ledger: Ledger,
  scope: TenantScope,
  s: SaleEffect,
  userId: string | null,
): Promise<void> {
  for (const line of ledgerLines(s, userId)) await ledger.post(scope, line);
}

/**
 * After an edit: reverses the old lines (dated on the old sale date) and
 * posts the new ones (dated on the new one). Nothing is written when the
 * edit doesn't touch the buyer, date, net or received amount. Returns
 * whether it reposted.
 */
export async function repostSale(
  ledger: Ledger,
  scope: TenantScope,
  before: SaleEffect,
  after: SaleEffect,
  userId: string | null,
): Promise<boolean> {
  if (!ledgerChanged(before, after)) return false;
  await ledger.reverse(scope, {
    sourceType: 'sale',
    sourceId: before.id,
    narration: `Sale ${before.billNo} edited`,
    entryDate: before.saleDate,
    userId,
  });
  await postSale(ledger, scope, after, userId);
  return true;
}

/** Cancel: reverses everything still open, dated today (the cancel day). */
export async function reverseSale(
  ledger: Ledger,
  scope: TenantScope,
  s: SaleEffect,
  userId: string | null,
): Promise<void> {
  await ledger.reverse(scope, {
    sourceType: 'sale',
    sourceId: s.id,
    narration: `Sale ${s.billNo} cancelled`,
    userId,
  });
}
