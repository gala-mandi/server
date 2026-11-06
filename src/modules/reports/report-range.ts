import type { FieldError } from '../../common/filters/all-exceptions.filter';
import { karachiDate } from '../../common/time/karachi-date';

export interface DateRange {
  from: string;
  to: string;
}

/** Days from `from` to `to`, both included: same day → 1. */
export function daysIn(from: string, to: string): number {
  return (
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000 +
    1
  );
}

/**
 * The range a report covers: `to` defaults to today (Asia/Karachi) and
 * `from` to `to`. Returns the field errors instead when `from` is after
 * `to` or the range is longer than `maxDays`.
 */
export function reportRange(
  query: { from?: string; to?: string },
  maxDays: number,
  now: Date = new Date(),
): DateRange | FieldError[] {
  const to = query.to ?? karachiDate(now);
  const from = query.from ?? to;
  if (from > to) {
    return [
      {
        field: 'from',
        message: 'The start date must be on or before the end date',
      },
    ];
  }
  if (daysIn(from, to) > maxDays) {
    return [{ field: 'to', message: `Choose at most ${maxDays} days` }];
  }
  return { from, to };
}
