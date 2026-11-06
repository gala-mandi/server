import {
  bookReportQuerySchema,
  dailySummaryQuerySchema,
  outstandingQuerySchema,
  reportRangeQuerySchema,
} from './reports.dto';

describe('reports DTOs', () => {
  it('a range takes calendar dates only', () => {
    expect(
      reportRangeQuerySchema.parse({ from: ' 2026-06-15 ', to: '2026-07-15' }),
    ).toEqual({ from: '2026-06-15', to: '2026-07-15' });
    const bad = reportRangeQuerySchema.safeParse({ from: '2026-02-30' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]).toMatchObject({
      path: ['from'],
      message: 'Enter the date as YYYY-MM-DD',
    });
  });

  it('the daily summary date is optional', () => {
    expect(dailySummaryQuerySchema.parse({})).toEqual({});
    expect(dailySummaryQuerySchema.safeParse({ date: 'today' }).success).toBe(
      false,
    );
  });

  it('purchases and sales group by day unless told otherwise', () => {
    expect(bookReportQuerySchema.parse({})).toEqual({ groupBy: 'day' });
    expect(bookReportQuerySchema.parse({ groupBy: 'commodity' }).groupBy).toBe(
      'commodity',
    );
    expect(bookReportQuerySchema.safeParse({ groupBy: 'month' }).success).toBe(
      false,
    );
    expect(
      bookReportQuerySchema.safeParse({ trader: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('a tenant_id in the query is not part of any report filter', () => {
    const parsed = bookReportQuerySchema.parse({
      tenant_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(parsed).not.toHaveProperty('tenant_id');
  });

  it('outstanding: type, asOf and a limit of 1 to 1000', () => {
    expect(
      outstandingQuerySchema.parse({ type: 'kissan', limit: '10' }),
    ).toEqual({ type: 'kissan', limit: 10 });
    expect(outstandingQuerySchema.safeParse({ limit: '0' }).success).toBe(
      false,
    );
    expect(outstandingQuerySchema.safeParse({ limit: '1001' }).success).toBe(
      false,
    );
    expect(outstandingQuerySchema.safeParse({ type: 'arhti' }).success).toBe(
      true,
    );
  });
});
