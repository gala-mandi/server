import { addDays, daysBetween } from '../../common/time/karachi-date';

/**
 * What a shop may do today, from its current subscription and the Pakistan
 * date. Worked out on every request, so a super-admin extension restores
 * full access at once (the daily job only keeps `status` tidy).
 *
 * - active: today <= ends_on
 * - grace: ends_on < today <= ends_on + grace_days (full access, banner warns)
 * - read_only: after the grace period (view and print only)
 */
export const ACCESS_STATES = ['active', 'grace', 'read_only'] as const;
export type AccessState = (typeof ACCESS_STATES)[number];

/** How long a new shop's trial runs (placeholder the owner may change). */
export const TRIAL_DAYS = 14;
/** Name of the plan every new shop starts on. */
export const TRIAL_PLAN_NAME = 'Trial';
/** Days before `ends_on` the daily job sends a reminder, once each. */
export const REMINDER_DAYS: readonly number[] = [7, 3, 1];

export interface SubscriptionDates {
  endsOn: string;
  graceDays: number;
}

export interface Access {
  state: AccessState;
  /** Last day of the grace period: ends_on + grace_days. */
  graceEndsOn: string;
  /** Days until ends_on (0 on the last day, never below 0). */
  daysLeft: number;
  /** Days until the grace period ends (never below 0). */
  graceDaysLeft: number;
}

export function accessFor(sub: SubscriptionDates, today: string): Access {
  const graceEndsOn = addDays(sub.endsOn, sub.graceDays);
  const state: AccessState =
    today <= sub.endsOn
      ? 'active'
      : today <= graceEndsOn
        ? 'grace'
        : 'read_only';
  return {
    state,
    graceEndsOn,
    daysLeft: Math.max(0, daysBetween(today, sub.endsOn)),
    graceDaysLeft: Math.max(0, daysBetween(today, graceEndsOn)),
  };
}

/** A shop without any subscription can only view (it should never happen). */
export function stateOf(
  sub: SubscriptionDates | null,
  today: string,
): AccessState {
  return sub ? accessFor(sub, today).state : 'read_only';
}

/** The reminder due today, if any (7, 3 or 1 days before ends_on). */
export function reminderDue(endsOn: string, today: string): number | null {
  const left = daysBetween(today, endsOn);
  return REMINDER_DAYS.includes(left) ? left : null;
}

/** Whether one more user fits: active users plus pending invites count. */
export function hasUserSeat(used: number, maxUsers: number): boolean {
  return used < maxUsers;
}

/** A Trial from `today` for `TRIAL_DAYS` days (both days included). */
export function trialPeriod(today: string): {
  startsOn: string;
  endsOn: string;
} {
  return { startsOn: today, endsOn: addDays(today, TRIAL_DAYS) };
}
