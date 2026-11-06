import Decimal from 'decimal.js';
import type { FieldError } from '../../common/filters/all-exceptions.filter';

/** paid (to a kissan) | received (from a beopari). */
export const DIRECTIONS = ['paid', 'received'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** The bill kind a direction settles: payments → purchases, receipts → sales. */
export const BILL_FIELD = {
  paid: 'purchaseId',
  received: 'saleId',
} as const satisfies Record<Direction, string>;

/** One line of `allocations` in the request, after the bill kind check. */
export interface AllocationRequest {
  billId: string;
  /** Rupees; left out = as much as the bill still needs and the amount has left. */
  amount?: string | null;
}

/** A bill as the allocation needs it (locked by the caller). */
export interface BillState {
  billNo: string;
  traderId: string;
  status: 'draft' | 'posted' | 'cancelled';
  /** net − paid/received on save − live allocations. */
  remaining: string;
}

export interface Allocation {
  billId: string;
  /** Rupees, 2 decimals. */
  amount: string;
}

export interface AllocationResult {
  allocations: Allocation[];
  /** Sum of the allocations. */
  allocated: string;
  /** What no bill takes: the advance (peshgi). */
  advance: string;
  errors: FieldError[];
}

/**
 * Splits a payment over the bills it names, in list order. Every bill must
 * be one of the trader's own, still posted, with something left to settle;
 * an allocation is never more than the bill's remaining amount nor more than
 * what is left of the payment. Whatever no bill takes is the advance.
 *
 * Pure: the caller looks the bills up (and locks them) first. `bills` has no
 * entry for a bill that is not in this shop, of the wrong kind or deleted.
 */
export function allocate(
  direction: Direction,
  traderId: string,
  amount: string,
  requests: readonly AllocationRequest[],
  bills: ReadonlyMap<string, BillState>,
): AllocationResult {
  const field = BILL_FIELD[direction];
  const errors: FieldError[] = [];
  const allocations: Allocation[] = [];
  const seen = new Set<string>();
  let left = new Decimal(amount);

  requests.forEach((request, i) => {
    const at = (name: string) => `allocations.${i}.${name}`;
    const bill = bills.get(request.billId);
    const billError = seen.has(request.billId)
      ? 'This bill is already in the list'
      : !bill
        ? 'Bill not found'
        : bill.traderId !== traderId
          ? 'This bill is of another trader'
          : bill.status === 'cancelled'
            ? 'This bill is cancelled'
            : bill.status !== 'posted'
              ? 'This bill is not posted'
              : new Decimal(bill.remaining).lte(0)
                ? `Nothing is left to settle on bill ${bill.billNo}`
                : null;
    seen.add(request.billId);
    if (billError || !bill) {
      errors.push({ field: at(field), message: billError ?? 'Bill not found' });
      return;
    }

    const remaining = new Decimal(bill.remaining);
    let share: Decimal;
    if (request.amount !== undefined && request.amount !== null) {
      share = new Decimal(request.amount);
      if (share.lte(0)) {
        errors.push({
          field: at('amount'),
          message: 'Enter an amount above 0',
        });
        return;
      }
      if (share.gt(remaining)) {
        errors.push({
          field: at('amount'),
          message: `Only Rs ${remaining.toFixed(2)} is left to settle on bill ${bill.billNo}`,
        });
        return;
      }
      if (share.gt(left)) {
        errors.push({
          field: at('amount'),
          message: `Only Rs ${Decimal.max(left, 0).toFixed(2)} of the amount is left for this bill`,
        });
        return;
      }
    } else {
      share = Decimal.min(remaining, left);
      if (share.lte(0)) {
        errors.push({
          field: at('amount'),
          message: 'Nothing of the amount is left for this bill',
        });
        return;
      }
    }
    left = left.minus(share);
    allocations.push({ billId: request.billId, amount: share.toFixed(2) });
  });

  const allocated = allocations.reduce(
    (sum, a) => sum.plus(a.amount),
    new Decimal(0),
  );
  return {
    allocations,
    allocated: allocated.toFixed(2),
    advance: new Decimal(amount).minus(allocated).toFixed(2),
    errors,
  };
}

/**
 * What is still to pay (purchase) or receive (sale) on a bill: the net less
 * the amount settled on the same save and the live allocations. 0 when the
 * bill is not posted.
 */
export function outstandingOf(bill: {
  status: string;
  netAmount: string;
  /** paid_amount (purchase) or received_amount (sale). */
  settledOnSave: string;
  /** Live allocations of posted payments. */
  allocated: string;
}): string {
  if (bill.status !== 'posted') return '0.00';
  return new Decimal(bill.netAmount)
    .minus(bill.settledOnSave)
    .minus(bill.allocated)
    .toFixed(2);
}

/**
 * What the khata says the shop owes the kissan (paid) or the beopari owes
 * the shop (received), from the trader's balance (debit − credit); never
 * below 0.
 */
export function owedOf(direction: Direction, balance: string): Decimal {
  const b = new Decimal(balance);
  return Decimal.max(direction === 'paid' ? b.negated() : b, 0);
}

/**
 * The part of a payment above what the khata owes, or null when it is not
 * more: "pay more than the balance". It becomes an advance, or the shop
 * blocks it.
 */
export function overpaymentOf(
  direction: Direction,
  amount: string,
  balance: string,
): string | null {
  const excess = new Decimal(amount).minus(owedOf(direction, balance));
  return excess.gt(0) ? excess.toFixed(2) : null;
}
