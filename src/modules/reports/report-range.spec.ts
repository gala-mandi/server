import { daysIn, reportRange } from './report-range';

// 02:00 PKT on 6 Nov 2026 is still 5 Nov in UTC.
const NOW = new Date('2026-11-05T21:00:00Z');

describe('daysIn()', () => {
  it('counts both ends', () => {
    expect(daysIn('2026-11-06', '2026-11-06')).toBe(1);
    expect(daysIn('2026-11-01', '2026-11-30')).toBe(30);
  });

  it('counts a leap year as 366 days', () => {
    expect(daysIn('2028-01-01', '2028-12-31')).toBe(366);
    expect(daysIn('2026-07-01', '2027-06-30')).toBe(365);
  });
});

describe('reportRange()', () => {
  it('defaults to today in Asia/Karachi', () => {
    expect(reportRange({}, 366, NOW)).toEqual({
      from: '2026-11-06',
      to: '2026-11-06',
    });
  });

  it('from alone runs to today; to alone is one day', () => {
    expect(reportRange({ from: '2026-07-01' }, 366, NOW)).toEqual({
      from: '2026-07-01',
      to: '2026-11-06',
    });
    expect(reportRange({ to: '2026-06-30' }, 366, NOW)).toEqual({
      from: '2026-06-30',
      to: '2026-06-30',
    });
  });

  it('a range across a financial year is one range', () => {
    expect(
      reportRange({ from: '2026-06-15', to: '2026-07-15' }, 366, NOW),
    ).toEqual({ from: '2026-06-15', to: '2026-07-15' });
  });

  it('takes a whole (leap) year and refuses one day more', () => {
    expect(
      reportRange({ from: '2027-07-01', to: '2028-06-30' }, 366, NOW),
    ).toEqual({ from: '2027-07-01', to: '2028-06-30' });
    expect(
      reportRange({ from: '2027-07-01', to: '2028-07-01' }, 366, NOW),
    ).toEqual([{ field: 'to', message: 'Choose at most 366 days' }]);
  });

  it('refuses a start after the end', () => {
    expect(
      reportRange({ from: '2026-11-07', to: '2026-11-06' }, 366, NOW),
    ).toEqual([
      {
        field: 'from',
        message: 'The start date must be on or before the end date',
      },
    ]);
  });
});
