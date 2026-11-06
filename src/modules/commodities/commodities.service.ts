import {
  ConflictException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { commodities, dailyRates, tenantSettings } from '../../database/schema';
import {
  TenantDatabase,
  type TenantScope,
} from '../../database/tenant-database';
import { RestorableRegistry } from '../audit/restorable-registry';
import { likePattern } from '../traders/traders.service';
import type {
  Commodity,
  CommodityLookupItem,
  CreateCommodityInput,
  ListCommoditiesQuery,
  LookupCommoditiesQuery,
  Unit,
  UpdateCommodityInput,
} from './commodities.dto';
import {
  effectiveCharges,
  SHOP_CHARGE_DEFAULTS,
  type ShopCharges,
} from './effective-charges';

type CommodityRow = typeof commodities.$inferSelect;

const NAME_KEY = 'commodities_tenant_id_name_key';

export function toCommodity(row: CommodityRow): Commodity {
  return {
    id: row.id,
    name: row.name,
    nameUr: row.nameUr,
    category: row.category,
    defaultUnit: row.defaultUnit as Unit,
    bagWeightKg: row.bagWeightKg,
    commissionPct: row.commissionPct,
    marketFeePct: row.marketFeePct,
    labourPerBag: row.labourPerBag,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** True for a unique violation on (tenant_id, name) (Postgres 23505). */
export function isNameUniqueViolation(error: unknown): boolean {
  for (const e of [error, (error as { cause?: unknown })?.cause]) {
    if (typeof e !== 'object' || e === null) continue;
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (code === '23505') return constraint === NAME_KEY;
  }
  return false;
}

const NAME_TAKEN_MESSAGE = 'Another commodity in this shop has this name';

const nameTaken = () =>
  new ConflictException({
    message: NAME_TAKEN_MESSAGE,
    code: 'NAME_TAKEN',
    errors: [{ field: 'name', message: NAME_TAKEN_MESSAGE }],
  });

const notFound = () => new NotFoundException('Commodity not found');

/** A shop's commodities. Every write is audited. */
@Injectable()
export class CommoditiesService implements OnModuleInit {
  constructor(
    private readonly db: TenantDatabase,
    private readonly restorable: RestorableRegistry,
  ) {}

  onModuleInit(): void {
    this.restorable.register('commodities', commodities);
  }

  list(query: ListCommoditiesQuery) {
    return this.db.transaction(async ({ tx, scoped }) => {
      const filters: SQL[] = [];
      if (query.active !== undefined) {
        filters.push(eq(commodities.isActive, query.active));
      }
      if (query.category) {
        filters.push(
          eq(sql`lower(${commodities.category})`, query.category.toLowerCase()),
        );
      }
      if (query.search) filters.push(this.searchFilter(query.search));
      const where = scoped(commodities).where(and(...filters));

      const order = {
        name: asc(commodities.name),
        '-name': desc(commodities.name),
        createdAt: asc(commodities.createdAt),
        '-createdAt': desc(commodities.createdAt),
      }[query.sort];

      const [rows, [{ total }]] = await Promise.all([
        tx
          .select()
          .from(commodities)
          .where(where)
          .orderBy(order, asc(commodities.id))
          .limit(query.limit)
          .offset((query.page - 1) * query.limit),
        tx.select({ total: count() }).from(commodities).where(where),
      ]);
      return {
        data: rows.map(toCommodity),
        meta: { page: query.page, limit: query.limit, total },
      };
    });
  }

  /**
   * Active commodities for pickers in rate, purchase and sale forms, with
   * the charges that apply to each (own value, else the shop default).
   */
  lookup(query: LookupCommoditiesQuery): Promise<CommodityLookupItem[]> {
    return this.db.transaction(async (scope) => {
      const { tx, scoped } = scope;
      const filters: SQL[] = [eq(commodities.isActive, true)];
      if (query.q) filters.push(this.searchFilter(query.q));
      // Names starting with q first. Only with q: a constant rank would be
      // `order by 0`, which Postgres reads as a (bad) column position.
      const prefix = likePattern(query.q).slice(1); // "gan%"
      const startsWith = query.q
        ? [
            sql`case when ${commodities.name} ilike ${prefix}
              or ${commodities.nameUr} ilike ${prefix} then 0 else 1 end`,
          ]
        : [];
      const [rows, shop] = await Promise.all([
        tx
          .select()
          .from(commodities)
          .where(scoped(commodities).where(and(...filters)))
          .orderBy(...startsWith, asc(commodities.name), asc(commodities.id))
          .limit(query.limit),
        this.shopCharges(scope),
      ]);
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        nameUr: row.nameUr,
        defaultUnit: row.defaultUnit as Unit,
        bagWeightKg: row.bagWeightKg,
        charges: effectiveCharges(row, shop),
      }));
    });
  }

  get(id: string): Promise<Commodity> {
    return this.db.transaction(async ({ scoped }) => {
      const row = await scoped(commodities).findById(id);
      if (!row) throw notFound();
      return toCommodity(row);
    });
  }

  async create(
    input: CreateCommodityInput,
    userId: string,
  ): Promise<Commodity> {
    try {
      return await this.db.transaction(async ({ tenantId, scoped }) => {
        // The scoped helper overwrites tenant_id; it never comes from the body.
        const values: typeof commodities.$inferInsert = {
          ...input,
          tenantId,
          createdBy: userId,
        };
        const [row] = await scoped(commodities).insert(values);
        return toCommodity(row);
      });
    } catch (error) {
      if (isNameUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  async update(id: string, input: UpdateCommodityInput): Promise<Commodity> {
    try {
      return await this.db.transaction(async ({ scoped }) => {
        const table = scoped(commodities);
        const row = Object.keys(input).length
          ? await table.update(id, input)
          : await table.findById(id);
        if (!row) throw notFound();
        return toCommodity(row);
      });
    } catch (error) {
      if (isNameUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  /** Soft delete; refused once rates, purchases or sales use it. */
  remove(id: string): Promise<void> {
    return this.db.transaction(async (scope) => {
      const row = await scope.scoped(commodities).findById(id);
      if (!row) throw notFound();
      if (await this.isInUse(scope, id)) {
        throw new ConflictException({
          message:
            'This commodity is used in rates, purchases or sales and cannot be deleted. Deactivate it instead.',
          code: 'COMMODITY_IN_USE',
        });
      }
      await scope.scoped(commodities).softDelete(id);
    });
  }

  /**
   * One check per table that points at commodities. `purchase_items` and
   * `sale_items` don't exist yet: the purchases and sales tickets each add
   * their check here.
   */
  private readonly usageChecks: ((
    scope: TenantScope,
    commodityId: string,
  ) => Promise<boolean>)[] = [
    async ({ scoped }, commodityId) =>
      (await scoped(dailyRates).count(
        eq(dailyRates.commodityId, commodityId),
      )) > 0,
  ];

  /** Whether any rate, purchase or sale uses this commodity. */
  private async isInUse(scope: TenantScope, id: string): Promise<boolean> {
    for (const check of this.usageChecks) {
      if (await check(scope, id)) return true;
    }
    return false;
  }

  /** The shop defaults; a shop without a settings row has the column defaults. */
  private async shopCharges({ tx, tenantId }: TenantScope) {
    const [row] = await tx
      .select({
        defaultCommissionPct: tenantSettings.defaultCommissionPct,
        marketFeePct: tenantSettings.marketFeePct,
        labourPerBag: tenantSettings.labourPerBag,
      })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId))
      .limit(1);
    return (row as ShopCharges | undefined) ?? SHOP_CHARGE_DEFAULTS;
  }

  private searchFilter(text: string): SQL {
    const pattern = likePattern(text);
    return or(
      ilike(commodities.name, pattern),
      ilike(commodities.nameUr, pattern),
    )!;
  }
}
