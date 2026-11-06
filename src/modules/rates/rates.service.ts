import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  lte,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Role } from '../../common/auth/auth-user';
import { karachiDate, previousDate } from '../../common/time/karachi-date';
import { diffChanges } from '../../database/audit/audit-diff';
import { commodities, dailyRates } from '../../database/schema';
import {
  TenantDatabase,
  type TenantScope,
} from '../../database/tenant-database';
import type {
  DayRates,
  ListRatesQuery,
  Rate,
  RateUnit,
  SaveRatesInput,
} from './rates.dto';

type RateRow = typeof dailyRates.$inferSelect;

/** Who may change the rates of a day before today (Asia/Karachi). */
export const PAST_DATE_ROLES: readonly Role[] = ['owner', 'manager'];

export const PAST_DATE_MESSAGE =
  'Only the owner or a manager can change the rates of a past day';

const COMMODITY_NOT_FOUND = 'Commodity not found';

export function toRate(row: RateRow): Rate {
  return {
    id: row.id,
    commodityId: row.commodityId,
    rateDate: row.rateDate,
    minRate: row.minRate,
    maxRate: row.maxRate,
    avgRate: row.avgRate,
    rateUnit: row.rateUnit as RateUnit,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A shop's daily rate per commodity, with full history. Every write is audited. */
@Injectable()
export class RatesService {
  constructor(private readonly db: TenantDatabase) {}

  /**
   * Today's rates (Asia/Karachi date), plus yesterday's as the starting
   * point for today's entry. Nothing is copied until the shop saves.
   */
  today(now: Date = new Date()) {
    const date = karachiDate(now);
    const yesterday = previousDate(date);
    return this.db.transaction(async (scope) => {
      const [data, previous] = await Promise.all([
        this.ratesOf(scope, date),
        this.ratesOf(scope, yesterday),
      ]);
      return { date, data, yesterday: { date: yesterday, data: previous } };
    });
  }

  /** History, newest day first by default; same day in commodity name order. */
  list(query: ListRatesQuery) {
    return this.db.transaction(async ({ tx, scoped }) => {
      const filters: SQL[] = [];
      if (query.commodity) {
        filters.push(eq(dailyRates.commodityId, query.commodity));
      }
      if (query.from) filters.push(gte(dailyRates.rateDate, query.from));
      if (query.to) filters.push(lte(dailyRates.rateDate, query.to));
      const where = scoped(dailyRates).where(and(...filters));
      const day =
        query.sort === 'rateDate'
          ? asc(dailyRates.rateDate)
          : desc(dailyRates.rateDate);

      const [rows, [{ total }]] = await Promise.all([
        tx
          .select(getTableColumns(dailyRates))
          .from(dailyRates)
          .innerJoin(commodities, eq(commodities.id, dailyRates.commodityId))
          .where(where)
          .orderBy(day, asc(commodities.name), asc(dailyRates.id))
          .limit(query.limit)
          .offset((query.page - 1) * query.limit),
        tx.select({ total: count() }).from(dailyRates).where(where),
      ]);
      return {
        data: rows.map(toRate),
        meta: { page: query.page, limit: query.limit, total },
      };
    });
  }

  /**
   * Saves many commodities' rates for one day at once: new commodities are
   * added, ones already saved that day are updated (never duplicated).
   * Days before today are for the owner and managers only.
   */
  save(
    date: string,
    input: SaveRatesInput,
    user: { id: string; role: Role },
    now: Date = new Date(),
  ): Promise<DayRates> {
    if (date < karachiDate(now) && !PAST_DATE_ROLES.includes(user.role)) {
      throw new ForbiddenException(PAST_DATE_MESSAGE);
    }
    return this.db.transaction(async (scope) => {
      const { tx, tenantId, scoped, audit } = scope;
      const ids = input.rates.map((r) => r.commodityId);

      // Another shop's commodity looks the same as one that doesn't exist.
      const known = await tx
        .select({ id: commodities.id })
        .from(commodities)
        .where(scoped(commodities).where(inArray(commodities.id, ids)));
      const knownIds = new Set(known.map((c) => c.id));
      const errors = ids.flatMap((id, i) =>
        knownIds.has(id)
          ? []
          : [{ field: `rates.${i}.commodityId`, message: COMMODITY_NOT_FOUND }],
      );
      if (errors.length) {
        throw new BadRequestException({
          message: 'Validation failed',
          errors,
        });
      }

      const existing = await tx
        .select()
        .from(dailyRates)
        .where(
          scoped(dailyRates).where(
            and(
              eq(dailyRates.rateDate, date),
              inArray(dailyRates.commodityId, ids),
            ),
          ),
        );
      const before = new Map(existing.map((r) => [r.commodityId, r]));

      const saved = await tx
        .insert(dailyRates)
        .values(
          input.rates.map((r) => ({
            ...r,
            tenantId,
            rateDate: date,
            createdBy: user.id,
          })),
        )
        .onConflictDoUpdate({
          target: [
            dailyRates.tenantId,
            dailyRates.commodityId,
            dailyRates.rateDate,
          ],
          set: {
            minRate: sql`excluded.min_rate`,
            maxRate: sql`excluded.max_rate`,
            avgRate: sql`excluded.avg_rate`,
            rateUnit: sql`excluded.rate_unit`,
            updatedAt: sql`now()`,
          },
        })
        .returning();

      for (const row of saved) {
        const old = before.get(row.commodityId);
        if (!old) {
          await audit({
            entity: 'daily_rates',
            entityId: row.id,
            action: 'create',
            after: row,
          });
          continue;
        }
        // Only changed fields, e.g. { maxRate: "4200.00" } → { maxRate: "4300.00" }.
        const changes = diffChanges(old, row);
        if (changes) {
          await audit({
            entity: 'daily_rates',
            entityId: row.id,
            action: 'update',
            ...changes,
          });
        }
      }

      return { date, data: await this.ratesOf(scope, date) };
    });
  }

  /** One day's rates, in commodity name order (as the entry grid lists them). */
  private async ratesOf(
    { tx, scoped }: TenantScope,
    date: string,
  ): Promise<Rate[]> {
    const rows = await tx
      .select(getTableColumns(dailyRates))
      .from(dailyRates)
      .innerJoin(commodities, eq(commodities.id, dailyRates.commodityId))
      .where(scoped(dailyRates).where(eq(dailyRates.rateDate, date)))
      .orderBy(asc(commodities.name), asc(dailyRates.id));
    return rows.map(toRate);
  }
}
