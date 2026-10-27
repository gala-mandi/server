import { randomInt } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import {
  refreshTokens,
  tenantSettings,
  tenants,
  users,
} from '../../database/schema';
import {
  PlatformDatabase,
  type PlatformScope,
} from '../../database/platform-database';
import { diffChanges } from '../../database/audit/audit-diff';
import { normalizePhone } from '../auth/identifier';
import { PasswordService } from '../auth/password.service';
import type {
  CreateTenantInput,
  ListTenantsQuery,
  TenantDetail,
  TenantSummary,
  UpdateTenantInput,
} from './tenants.dto';

type Tx = PlatformScope['tx'];
type TenantRow = typeof tenants.$inferSelect;

// No 0/O, 1/l/I: the owner may have to read it out over the phone.
const PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export function temporaryPassword(length = 12): string {
  for (;;) {
    let out = '';
    for (let i = 0; i < length; i++) {
      out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
    }
    // At least one letter and one digit.
    if (/\d/.test(out) && /[a-z]/i.test(out)) return out;
  }
}

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    // Drop accents (ü → u) instead of turning them into dashes.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return slug || 'shop';
}

const phoneTaken = () =>
  new ConflictException({
    message: 'This phone already has an account',
    code: 'PHONE_TAKEN',
    errors: [
      { field: 'owner.phone', message: 'This phone already has an account' },
    ],
  });

const emailTaken = () =>
  new ConflictException({
    message: 'This email already has an account',
    code: 'EMAIL_TAKEN',
    errors: [
      { field: 'owner.email', message: 'This email already has an account' },
    ],
  });

/** Super-admin management of shops. Every write is audited. */
@Injectable()
export class TenantsService {
  constructor(
    private readonly platform: PlatformDatabase,
    private readonly passwords: PasswordService,
  ) {}

  list(query: ListTenantsQuery) {
    return this.platform.transaction(async ({ tx }) => {
      const filters: SQL[] = [isNull(tenants.deletedAt)];
      if (query.status) filters.push(eq(tenants.status, query.status));
      if (query.search) filters.push(this.searchFilter(query.search));
      const where = and(...filters);

      const order = {
        createdAt: asc(tenants.createdAt),
        '-createdAt': desc(tenants.createdAt),
        name: asc(tenants.name),
        '-name': desc(tenants.name),
      }[query.sort];

      const [rows, [{ total }]] = await Promise.all([
        tx
          .select()
          .from(tenants)
          .where(where)
          .orderBy(order, desc(tenants.id))
          .limit(query.limit)
          .offset((query.page - 1) * query.limit),
        tx.select({ total: count() }).from(tenants).where(where),
      ]);
      const counts = await this.userCounts(
        tx,
        rows.map((r) => r.id),
      );

      return {
        data: rows.map((row) => this.toSummary(row, counts.get(row.id) ?? 0)),
        meta: { page: query.page, limit: query.limit, total },
      };
    });
  }

  get(id: string): Promise<TenantDetail> {
    return this.platform.transaction(({ tx }) => this.detail(tx, id));
  }

  /** Shop + owner (temporary password) + default settings, all or nothing. */
  async create(
    input: CreateTenantInput,
  ): Promise<{ tenant: TenantDetail; temporaryPassword: string }> {
    const password = temporaryPassword();
    const passwordHash = await this.passwords.hash(password);
    const ownerPhone = normalizePhone(input.owner.phone);
    const ownerEmail = input.owner.email?.toLowerCase() ?? null;

    // A slug can be taken between our check and the insert by a create
    // running at the same time; retrying then picks the next free slug (or
    // finds the phone taken, for a double-submitted form).
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.createOnce(
          input,
          ownerPhone,
          ownerEmail,
          passwordHash,
          password,
        );
      } catch (error) {
        const constraint = uniqueViolation(error);
        if (constraint?.includes('slug') && attempt < 3) continue;
        // Two creates racing for the same phone/email: the unique index wins.
        if (constraint?.includes('email')) throw emailTaken();
        if (constraint?.includes('phone')) throw phoneTaken();
        throw error;
      }
    }
  }

  private createOnce(
    input: CreateTenantInput,
    ownerPhone: string,
    ownerEmail: string | null,
    passwordHash: string,
    password: string,
  ): Promise<{ tenant: TenantDetail; temporaryPassword: string }> {
    return this.platform.transaction(async ({ tx, audit }) => {
      const [taken] = await tx
        .select({ phone: users.phone, email: users.email })
        .from(users)
        .where(
          ownerEmail
            ? or(
                eq(users.phone, ownerPhone),
                eq(sql`lower(${users.email})`, ownerEmail),
              )
            : eq(users.phone, ownerPhone),
        )
        .limit(1);
      if (taken) throw taken.phone === ownerPhone ? phoneTaken() : emailTaken();

      const [tenant] = await tx
        .insert(tenants)
        .values({
          name: input.name,
          slug: await this.uniqueSlug(tx, slugify(input.name)),
          ownerName: input.owner.name,
          phone: normalizePhone(input.phone),
          email: input.email,
          address: input.address,
          city: input.city,
        })
        .returning();
      const [owner] = await tx
        .insert(users)
        .values({
          tenantId: tenant.id,
          name: input.owner.name,
          phone: ownerPhone,
          email: ownerEmail,
          passwordHash,
          role: 'owner',
          mustChangePassword: true,
        })
        .returning();
      const [settings] = await tx
        .insert(tenantSettings)
        .values({ tenantId: tenant.id, displayName: input.name })
        .returning();

      await audit({
        tenantId: tenant.id,
        entity: 'tenants',
        entityId: tenant.id,
        action: 'create',
        after: tenant,
      });
      await audit({
        tenantId: tenant.id,
        entity: 'users',
        entityId: owner.id,
        action: 'create',
        after: owner,
      });
      await audit({
        tenantId: tenant.id,
        entity: 'tenant_settings',
        entityId: tenant.id,
        action: 'create',
        after: settings,
      });

      return {
        tenant: await this.detail(tx, tenant.id),
        temporaryPassword: password,
      };
    });
  }

  update(id: string, input: UpdateTenantInput): Promise<TenantDetail> {
    return this.platform.transaction(async ({ tx, audit }) => {
      const before = await this.row(tx, id);
      const values = {
        ...input,
        ...(input.phone && { phone: normalizePhone(input.phone) }),
      };
      if (Object.keys(values).length) {
        const [after] = await tx
          .update(tenants)
          .set(values)
          .where(eq(tenants.id, id))
          .returning();
        // Only changed fields; nothing logged when nothing changed.
        const changes = diffChanges(before, after);
        if (changes) {
          await audit({
            tenantId: id,
            entity: 'tenants',
            entityId: id,
            action: 'update',
            ...changes,
          });
        }
      }
      return this.detail(tx, id);
    });
  }

  /** Blocks sign-in and ends every session of the shop's users. */
  suspend(id: string): Promise<TenantDetail> {
    return this.platform.transaction(async ({ tx, audit }) => {
      const before = await this.row(tx, id);
      if (before.status !== 'suspended') {
        await tx
          .update(tenants)
          .set({ status: 'suspended' })
          .where(eq(tenants.id, id));
        await tx
          .update(refreshTokens)
          .set({ revokedAt: sql`now()` })
          .where(
            and(
              isNull(refreshTokens.revokedAt),
              inArray(
                refreshTokens.userId,
                tx
                  .select({ id: users.id })
                  .from(users)
                  .where(eq(users.tenantId, id)),
              ),
            ),
          );
        await audit({
          tenantId: id,
          entity: 'tenants',
          entityId: id,
          action: 'update',
          before: { status: before.status },
          after: { status: 'suspended' },
        });
      }
      return this.detail(tx, id);
    });
  }

  activate(id: string): Promise<TenantDetail> {
    return this.platform.transaction(async ({ tx, audit }) => {
      const before = await this.row(tx, id);
      if (before.status !== 'active') {
        await tx
          .update(tenants)
          .set({ status: 'active' })
          .where(eq(tenants.id, id));
        await audit({
          tenantId: id,
          entity: 'tenants',
          entityId: id,
          action: 'update',
          before: { status: before.status },
          after: { status: 'active' },
        });
      }
      return this.detail(tx, id);
    });
  }

  private searchFilter(search: string): SQL {
    const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
    const digits = search.replace(/\D/g, '');
    const conditions: SQL[] = [
      ilike(tenants.name, like),
      ilike(tenants.ownerName, like),
      ilike(tenants.city, like),
      ilike(tenants.phone, like),
    ];
    if (digits.length >= 3) {
      // "0300 123", "+92 300 123" … all find 03001234567.
      const local = digits.startsWith('92')
        ? digits.slice(2)
        : digits.replace(/^0/, '');
      const phoneLike = `%${local}%`;
      conditions.push(ilike(tenants.phone, phoneLike));
      conditions.push(
        sql`exists (select 1 from ${users} where ${users.tenantId} = ${tenants.id}
          and ${users.role} = 'owner' and ${users.phone} ilike ${phoneLike})`,
      );
    }
    return or(...conditions)!;
  }

  private async uniqueSlug(tx: Tx, base: string): Promise<string> {
    const taken = new Set(
      (
        await tx
          .select({ slug: tenants.slug })
          .from(tenants)
          .where(or(eq(tenants.slug, base), ilike(tenants.slug, `${base}-%`)))
      ).map((r) => r.slug),
    );
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
    }
  }

  private async userCounts(
    tx: Tx,
    ids: string[],
  ): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await tx
      .select({ tenantId: users.tenantId, n: count() })
      .from(users)
      .where(and(inArray(users.tenantId, ids), isNull(users.deletedAt)))
      .groupBy(users.tenantId);
    return new Map(rows.map((r) => [r.tenantId as string, r.n]));
  }

  private async row(tx: Tx, id: string): Promise<TenantRow> {
    const [row] = await tx
      .select()
      .from(tenants)
      .where(and(eq(tenants.id, id), isNull(tenants.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException('Shop not found');
    return row;
  }

  private async detail(tx: Tx, id: string): Promise<TenantDetail> {
    const row = await this.row(tx, id);
    const [owner] = await tx
      .select({
        id: users.id,
        name: users.name,
        phone: users.phone,
        email: users.email,
        isActive: users.isActive,
        mustChangePassword: users.mustChangePassword,
      })
      .from(users)
      .where(
        and(
          eq(users.tenantId, id),
          eq(users.role, 'owner'),
          isNull(users.deletedAt),
        ),
      )
      .orderBy(asc(users.createdAt))
      .limit(1);
    const counts = await this.userCounts(tx, [id]);
    return {
      ...this.toSummary(row, counts.get(id) ?? 0),
      email: row.email,
      address: row.address,
      logoUrl: row.logoUrl,
      updatedAt: row.updatedAt.toISOString(),
      owner: owner ?? null,
    };
  }

  private toSummary(row: TenantRow, userCount: number): TenantSummary {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      city: row.city,
      phone: row.phone,
      ownerName: row.ownerName,
      status: row.status,
      userCount,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** The violated unique constraint's name, if this is a unique violation. */
function uniqueViolation(error: unknown): string | null {
  for (const e of [error, (error as { cause?: unknown })?.cause]) {
    if (typeof e !== 'object' || e === null) continue;
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (code === '23505')
      return typeof constraint === 'string' ? constraint : '';
  }
  return null;
}
