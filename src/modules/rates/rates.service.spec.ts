import { ForbiddenException } from '@nestjs/common';
import type { Role } from '../../common/auth/auth-user';
import type { dailyRates } from '../../database/schema';
import type { TenantDatabase } from '../../database/tenant-database';
import { rateSchema, type SaveRatesInput } from './rates.dto';
import { PAST_DATE_MESSAGE, RatesService, toRate } from './rates.service';

type RateRow = typeof dailyRates.$inferSelect;

const SHOP = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const COMMODITY = '33333333-3333-4333-8333-333333333333';
const ID = '44444444-4444-4444-8444-444444444444';

// 00:30 on 6 Nov in Pakistan (19:30 UTC on 5 Nov).
const NOW = new Date('2026-11-05T19:30:00.000Z');

const INPUT: SaveRatesInput = {
  rates: [
    {
      commodityId: COMMODITY,
      minRate: '4000',
      maxRate: '4200',
      avgRate: null,
      rateUnit: 'maund',
    },
  ],
};

function row(over: Partial<RateRow> = {}): RateRow {
  return {
    id: ID,
    tenantId: SHOP,
    createdBy: USER,
    createdAt: new Date('2026-11-06T04:00:00.000Z'),
    updatedAt: new Date('2026-11-06T05:15:00.000Z'),
    deletedAt: null,
    commodityId: COMMODITY,
    rateDate: '2026-11-06',
    minRate: '4000.00',
    maxRate: '4200.00',
    avgRate: '4100.00',
    rateUnit: 'maund',
    ...over,
  };
}

/** A service whose transaction never touches a database. */
function fakeService() {
  const transaction = jest.fn(() => Promise.resolve({ date: '', data: [] }));
  const service = new RatesService({
    transaction,
  } as unknown as TenantDatabase);
  return { service, transaction };
}

const user = (role: Role) => ({ id: USER, role });

describe('toRate', () => {
  it('maps a row to the API shape (valid against the response schema)', () => {
    const rate = toRate(row());

    expect(rate).toEqual({
      id: ID,
      commodityId: COMMODITY,
      rateDate: '2026-11-06',
      minRate: '4000.00',
      maxRate: '4200.00',
      avgRate: '4100.00',
      rateUnit: 'maund',
      createdAt: '2026-11-06T04:00:00.000Z',
      updatedAt: '2026-11-06T05:15:00.000Z',
    });
    expect(rateSchema.safeParse(rate).success).toBe(true);
  });
});

describe('RatesService.save() past days', () => {
  it.each<Role>(['owner', 'manager'])(
    '%s may change yesterday',
    async (role) => {
      const { service, transaction } = fakeService();

      await service.save('2026-11-05', INPUT, user(role), NOW);

      expect(transaction).toHaveBeenCalledTimes(1);
    },
  );

  it('anyone else changing yesterday → 403 before anything is read', () => {
    const { service, transaction } = fakeService();

    expect(() =>
      service.save('2026-11-05', INPUT, user('operator'), NOW),
    ).toThrow(new ForbiddenException(PAST_DATE_MESSAGE));
    expect(transaction).not.toHaveBeenCalled();
  });

  it('"today" is the Pakistan date: at 00:30 PKT, 6 Nov is today, not past', async () => {
    const { service, transaction } = fakeService();

    await service.save('2026-11-06', INPUT, user('operator'), NOW);

    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe('RatesService.today()', () => {
  it("returns today's and yesterday's Pakistan dates with their rates", async () => {
    const scope = {
      tx: {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({ orderBy: () => Promise.resolve([row()]) }),
            }),
          }),
        }),
      },
      scoped: () => ({ where: (sql: unknown) => sql }),
    };
    const service = new RatesService({
      transaction: (fn: (s: unknown) => unknown) => fn(scope),
    } as unknown as TenantDatabase);

    const result = await service.today(NOW);

    expect(result).toEqual({
      date: '2026-11-06',
      data: [toRate(row())],
      yesterday: { date: '2026-11-05', data: [toRate(row())] },
    });
  });
});
