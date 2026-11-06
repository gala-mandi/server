/**
 * Calendar dates as the mandi sees them: Asia/Karachi, not UTC. A date is a
 * plain 'YYYY-MM-DD' string, as Postgres `date` columns hold it.
 *
 * Uses the runtime's time-zone data (`Intl`), so no date library is needed.
 * Pakistan is UTC+5 all year (no daylight saving).
 */

export const SHOP_TIME_ZONE = 'Asia/Karachi';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// en-CA formats dates as YYYY-MM-DD.
const karachiFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHOP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Pakistan date at `now`, e.g. 00:30 PKT on 6 Nov → '2026-11-06'. */
export function karachiDate(now: Date = new Date()): string {
  return karachiFormat.format(now);
}

/** True for a real calendar date in 'YYYY-MM-DD' form ('2026-02-30' is not). */
export function isCalendarDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/** The calendar day before `date`: '2026-03-01' → '2026-02-28'. */
export function previousDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}
