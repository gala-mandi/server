import { karachiDate } from '../../common/time/karachi-date';
import {
  accessFor,
  hasUserSeat,
  reminderDue,
  stateOf,
  TRIAL_DAYS,
  trialPeriod,
} from './access-state';

const sub = { endsOn: '2026-11-20', graceDays: 7 };

describe('accessFor()', () => {
  it.each([
    // Before and on the end date: full access.
    ['2026-11-06', 'active', 14, 21],
    ['2026-11-19', 'active', 1, 8],
    ['2026-11-20', 'active', 0, 7],
    // Grace: the day after the end date up to end + 7 days.
    ['2026-11-21', 'grace', 0, 6],
    ['2026-11-26', 'grace', 0, 1],
    ['2026-11-27', 'grace', 0, 0],
    // After the grace period: read-only.
    ['2026-11-28', 'read_only', 0, 0],
    ['2027-03-01', 'read_only', 0, 0],
  ])(
    'on %s the shop is %s (%d days left, %d grace days left)',
    (today, state, daysLeft, graceDaysLeft) => {
      expect(accessFor(sub, today)).toEqual({
        state,
        graceEndsOn: '2026-11-27',
        daysLeft,
        graceDaysLeft,
      });
    },
  );

  it('grace of 0 days: read-only the day after the end date', () => {
    const noGrace = { endsOn: '2026-11-20', graceDays: 0 };
    expect(accessFor(noGrace, '2026-11-20').state).toBe('active');
    expect(accessFor(noGrace, '2026-11-21').state).toBe('read_only');
  });

  it('grace crosses a month and a year end', () => {
    expect(
      accessFor({ endsOn: '2026-12-28', graceDays: 7 }, '2027-01-04'),
    ).toMatchObject({ state: 'grace', graceEndsOn: '2027-01-04' });
    expect(
      accessFor({ endsOn: '2026-12-28', graceDays: 7 }, '2027-01-05').state,
    ).toBe('read_only');
  });

  it('works on the Karachi date: 00:30 PKT is already the next day', () => {
    // 19:30 UTC on the 27th is 00:30 on the 28th in Pakistan.
    const today = karachiDate(new Date('2026-11-27T19:30:00Z'));
    expect(today).toBe('2026-11-28');
    expect(accessFor(sub, today).state).toBe('read_only');
    // 18:59 UTC is still 23:59 on the 27th: last day of grace.
    expect(
      accessFor(sub, karachiDate(new Date('2026-11-27T18:59:00Z'))).state,
    ).toBe('grace');
  });

  it('a later end date (extension) gives full access at once', () => {
    expect(accessFor(sub, '2026-12-10').state).toBe('read_only');
    expect(
      accessFor({ ...sub, endsOn: '2027-01-10' }, '2026-12-10').state,
    ).toBe('active');
  });
});

describe('stateOf()', () => {
  it('no subscription: read-only', () => {
    expect(stateOf(null, '2026-11-06')).toBe('read_only');
  });

  it('follows the dates', () => {
    expect(stateOf(sub, '2026-11-06')).toBe('active');
    expect(stateOf(sub, '2026-11-25')).toBe('grace');
  });
});

describe('reminderDue()', () => {
  it.each([
    ['2026-11-13', 7],
    ['2026-11-17', 3],
    ['2026-11-19', 1],
  ])('on %s: the %d-day reminder', (today, days) => {
    expect(reminderDue('2026-11-20', today)).toBe(days);
  });

  it.each([
    '2026-11-12',
    '2026-11-14',
    '2026-11-18',
    '2026-11-20',
    '2026-11-21',
  ])('on %s: none', (today) => {
    expect(reminderDue('2026-11-20', today)).toBeNull();
  });
});

describe('hasUserSeat()', () => {
  it.each([
    [0, 3, true],
    [2, 3, true],
    [3, 3, false],
    [4, 3, false],
    [0, 0, false],
  ])('%d used of %d: room for one more is %s', (used, max, expected) => {
    expect(hasUserSeat(used, max)).toBe(expected);
  });
});

describe('trialPeriod()', () => {
  it(`runs ${TRIAL_DAYS} days from today`, () => {
    expect(trialPeriod('2026-11-06')).toEqual({
      startsOn: '2026-11-06',
      endsOn: '2026-11-20',
    });
  });

  it('crosses the year end', () => {
    expect(trialPeriod('2026-12-25').endsOn).toBe('2027-01-08');
  });
});
