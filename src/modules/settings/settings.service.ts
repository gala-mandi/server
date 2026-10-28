import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { diffChanges } from '../../database/audit/audit-diff';
import { tenantSettings, tenants } from '../../database/schema';
import {
  TenantDatabase,
  type TenantScope,
} from '../../database/tenant-database';
import {
  FILE_STORAGE,
  type FileStorage,
} from '../../common/storage/file-storage';
import { normalizePhone } from '../auth/identifier';
import type { LogoFile } from './logo-file';
import type { Settings, UpdateSettingsInput } from './settings.dto';

type TenantRow = typeof tenants.$inferSelect;
type SettingsRow = typeof tenantSettings.$inferSelect;

const TENANT_FIELDS = [
  'name',
  'phone',
  'email',
  'address',
  'city',
  'logoUrl',
] as const;

export function toSettings(tenant: TenantRow, row: SettingsRow): Settings {
  const updatedAt =
    tenant.updatedAt > row.updatedAt ? tenant.updatedAt : row.updatedAt;
  return {
    name: tenant.name,
    phone: tenant.phone,
    email: tenant.email,
    address: tenant.address,
    city: tenant.city,
    logoUrl: tenant.logoUrl,
    displayName: row.displayName,
    parchiFooter: row.parchiFooter,
    defaultCommissionPct: row.defaultCommissionPct,
    marketFeePct: row.marketFeePct,
    labourPerBag: row.labourPerBag,
    defaultUnit: row.defaultUnit as Settings['defaultUnit'],
    maundKg: row.maundKg,
    billPrefix: row.billPrefix,
    financialYearStart: row.financialYearStart,
    language: row.language as Settings['language'],
    updatedAt: updatedAt.toISOString(),
  };
}

/** Splits a PATCH body into its `tenants` part and its `tenant_settings` part. */
export function splitUpdate(input: UpdateSettingsInput) {
  const shop: Partial<Record<(typeof TENANT_FIELDS)[number], string | null>> =
    {};
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if ((TENANT_FIELDS as readonly string[]).includes(key)) {
      shop[key as (typeof TENANT_FIELDS)[number]] =
        key === 'phone' ? normalizePhone(value as string) : value;
    } else {
      settings[key] = value;
    }
  }
  return {
    shop: shop as Partial<TenantRow>,
    settings: settings as Partial<SettingsRow>,
  };
}

/** The signed-in owner's shop settings. Every change is audited. */
@Injectable()
export class SettingsService {
  constructor(
    private readonly db: TenantDatabase,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  get(): Promise<Settings> {
    return this.db.transaction(async (scope) => {
      const tenant = await this.tenant(scope);
      return toSettings(tenant, await this.settingsRow(scope, tenant));
    });
  }

  update(input: UpdateSettingsInput): Promise<Settings> {
    return this.apply(splitUpdate(input));
  }

  /** Stores the (already checked) image, then points the shop at it. */
  async uploadLogo({ body, ext, contentType }: LogoFile): Promise<Settings> {
    const { url } = await this.storage.put({
      key: `tenants/${this.db.tenantId}/logo-${randomUUID()}.${ext}`,
      body,
      contentType,
    });
    return this.apply({ shop: { logoUrl: url }, settings: {} });
  }

  private apply({
    shop,
    settings,
  }: ReturnType<typeof splitUpdate>): Promise<Settings> {
    return this.db.transaction(async (scope) => {
      const { tx, tenantId, audit } = scope;
      let tenant = await this.tenant(scope);
      let row = await this.settingsRow(scope, tenant);

      if (Object.keys(shop).length) {
        const before = tenant;
        [tenant] = await tx
          .update(tenants)
          .set(shop)
          .where(eq(tenants.id, tenantId))
          .returning();
        const changes = diffChanges(before, tenant);
        if (changes) {
          await audit({
            entity: 'tenants',
            entityId: tenantId,
            action: 'update',
            ...changes,
          });
        }
      }

      if (Object.keys(settings).length) {
        const before = row;
        [row] = await tx
          .update(tenantSettings)
          .set(settings)
          .where(eq(tenantSettings.tenantId, tenantId))
          .returning();
        const changes = diffChanges(before, row);
        if (changes) {
          await audit({
            entity: 'tenant_settings',
            entityId: tenantId,
            action: 'update',
            ...changes,
          });
        }
      }

      return toSettings(tenant, row);
    });
  }

  private async tenant({ tx, tenantId }: TenantScope): Promise<TenantRow> {
    const [tenant] = await tx
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundException('Shop not found');
    return tenant;
  }

  /** Every shop gets its row on creation; older shops get defaults here. */
  private async settingsRow(
    { tx, tenantId }: TenantScope,
    tenant: TenantRow,
  ): Promise<SettingsRow> {
    const select = () =>
      tx
        .select()
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tenantId))
        .limit(1);
    const [row] = await select();
    if (row) return row;
    // Two first requests at once: one inserts, the other reads its row.
    await tx
      .insert(tenantSettings)
      .values({ tenantId, displayName: tenant.name })
      .onConflictDoNothing();
    const [created] = await select();
    return created;
  }
}
