import { isCalendarDate, karachiDate, previousDate } from './karachi-date';

describe('karachiDate', () => {
  it('00:30 in Pakistan is already the new day (19:30 UTC the day before)', () => {
    expect(karachiDate(new Date('2026-11-05T19:30:00.000Z'))).toBe(
      '2026-11-06',
    );
  });

  it('23:59 in Pakistan is still the same day', () => {
    expect(karachiDate(new Date('2026-11-06T18:59:59.999Z'))).toBe(
      '2026-11-06',
    );
  });

  it('exactly midnight in Pakistan (19:00 UTC) starts the next day', () => {
    expect(karachiDate(new Date('2026-11-05T18:59:59.999Z'))).toBe(
      '2026-11-05',
    );
    expect(karachiDate(new Date('2026-11-05T19:00:00.000Z'))).toBe(
      '2026-11-06',
    );
  });

  it('crosses month and year ends in Pakistan time', () => {
    expect(karachiDate(new Date('2026-12-31T19:00:00.000Z'))).toBe(
      '2027-01-01',
    );
  });

  it('no daylight saving: summer is UTC+5 too', () => {
    expect(karachiDate(new Date('2026-06-15T19:00:00.000Z'))).toBe(
      '2026-06-16',
    );
  });

  it('defaults to now', () => {
    expect(karachiDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('previousDate', () => {
  it.each([
    ['2026-11-06', '2026-11-05'],
    ['2026-03-01', '2026-02-28'],
    ['2028-03-01', '2028-02-29'],
    ['2027-01-01', '2026-12-31'],
  ])('%s → %s', (date, expected) => {
    expect(previousDate(date)).toBe(expected);
  });
});

describe('isCalendarDate', () => {
  it.each(['2026-11-06', '2028-02-29', '2026-12-31'])('%s is a date', (v) => {
    expect(isCalendarDate(v)).toBe(true);
  });

  it.each([
    '2026-02-29',
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '2026-11-6',
    '06-11-2026',
    '2026-11-06T00:00:00Z',
    'today',
    '',
  ])('%s is not', (v) => {
    expect(isCalendarDate(v)).toBe(false);
  });
});
