import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  accountDisabled,
  tenantSuspended,
} from '../../common/auth/auth-errors';
import { permissionsFor } from '../../common/auth/permissions';
import { DRIZZLE, type Database } from '../../database/database.module';
import { tenants, users } from '../../database/schema';
import type { Identifier } from './identifier';
import type { UserDto } from './dto/session.dto';

export type UserRow = typeof users.$inferSelect;
export type TenantRow = typeof tenants.$inferSelect;

export interface UserWithTenant {
  user: UserRow;
  tenant: TenantRow | null;
}

const BLOCKED_TENANT_STATUSES: TenantRow['status'][] = [
  'suspended',
  'cancelled',
];

/** Reads users for auth. Soft-deleted users are never returned. */
@Injectable()
export class AuthUsersService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findByIdentifier(
    identifier: Identifier,
  ): Promise<UserWithTenant | null> {
    const match =
      identifier.kind === 'email'
        ? eq(sql`lower(${users.email})`, identifier.value)
        : eq(users.phone, identifier.value);
    return this.findOne(match);
  }

  findById(id: string): Promise<UserWithTenant | null> {
    return this.findOne(eq(users.id, id));
  }

  private async findOne(
    match: ReturnType<typeof eq>,
  ): Promise<UserWithTenant | null> {
    const [row] = await this.db
      .select({ user: users, tenant: tenants })
      .from(users)
      .leftJoin(tenants, eq(users.tenantId, tenants.id))
      .where(and(match, isNull(users.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  /** Throws 403 with a code when the user or their shop may not sign in. */
  assertCanSignIn({ user, tenant }: UserWithTenant): void {
    if (!user.isActive) throw accountDisabled();
    if (
      tenant &&
      (tenant.deletedAt || BLOCKED_TENANT_STATUSES.includes(tenant.status))
    ) {
      throw tenantSuspended();
    }
  }

  /** Public shape of a user. Never includes the password hash. */
  toDto({ user, tenant }: UserWithTenant): UserDto {
    return {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      mustChangePassword: user.mustChangePassword,
      permissions: [...permissionsFor(user.role)],
      tenant: tenant
        ? {
            id: tenant.id,
            name: tenant.name,
            logoUrl: tenant.logoUrl,
            status: tenant.status,
          }
        : null,
    };
  }
}
