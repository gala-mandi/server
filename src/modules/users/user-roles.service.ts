import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { AuthUser, Role } from '../../common/auth/auth-user';
import { roleHas } from '../../common/auth/permissions';
import { users } from '../../database/schema';
import {
  TenantDatabase,
  type TenantScope,
} from '../../database/tenant-database';

export type ShopRole = Exclude<Role, 'super_admin'>;
type UserRow = typeof users.$inferSelect;

export interface StaffMember {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: ShopRole;
  isActive: boolean;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  createdAt: string;
  isYou: boolean;
}

const lastOwner = () =>
  new BadRequestException({
    message: 'A shop needs at least one owner',
    errors: [{ field: 'role', message: 'A shop needs at least one owner' }],
  });

export function toStaffMember(row: UserRow, actorId: string): StaffMember {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    role: row.role as ShopRole,
    isActive: row.isActive,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    mustChangePassword: row.mustChangePassword,
    createdAt: row.createdAt.toISOString(),
    isYou: row.id === actorId,
  };
}

/**
 * Staff of the actor's shop: list, change role, deactivate, activate.
 * A shop always keeps at least one active owner. A new role reaches the
 * user's next access token (next refresh); deactivation is immediate.
 */
@Injectable()
export class UserRolesService {
  constructor(private readonly tenantDb: TenantDatabase) {}

  async list(actor: AuthUser): Promise<StaffMember[]> {
    this.assertCanManage(actor);
    return this.tenantDb.transaction(async ({ tx, scoped }) => {
      const rows = await tx
        .select()
        .from(users)
        .where(scoped(users).where())
        .orderBy(
          sql`case when ${users.role} = 'owner' then 0 else 1 end`,
          asc(users.name),
        );
      return rows.map((row) => toStaffMember(row, actor.id));
    });
  }

  async changeRole(
    actor: AuthUser,
    userId: string,
    role: ShopRole,
  ): Promise<StaffMember> {
    this.assertCanManage(actor);
    if ((role as Role) === 'super_admin') {
      throw new BadRequestException('Shop users cannot be platform admins');
    }
    return this.tenantDb.transaction(async (scope) => {
      // Lock first, then read: decisions use the row as it is under the lock.
      await this.lockOwners(scope);
      const target = await this.target(scope, userId);
      if (target.role !== role && target.role === 'owner') {
        await this.assertAnotherActiveOwner(scope, target.id);
      }
      const after =
        target.role === role
          ? target
          : await scope.scoped(users).update(target.id, { role });
      return toStaffMember(after ?? target, actor.id);
    });
  }

  /** Sign-in blocked and every session ended right away (JWT check). */
  async setActive(
    actor: AuthUser,
    userId: string,
    isActive: boolean,
  ): Promise<StaffMember> {
    this.assertCanManage(actor);
    if (!isActive && userId === actor.id) {
      throw new BadRequestException({
        message: "You can't deactivate yourself",
        code: 'CANNOT_DEACTIVATE_SELF',
      });
    }
    return this.tenantDb.transaction(async (scope) => {
      if (!isActive) await this.lockOwners(scope);
      const target = await this.target(scope, userId);
      if (!isActive && target.role === 'owner' && target.isActive) {
        await this.assertAnotherActiveOwner(scope, target.id);
      }
      const after =
        target.isActive === isActive
          ? target
          : await scope.scoped(users).update(target.id, { isActive });
      return toStaffMember(after ?? target, actor.id);
    });
  }

  private assertCanManage(actor: AuthUser): void {
    if (!roleHas(actor.role, 'staff.manage')) {
      throw new ForbiddenException('You do not have access to this action');
    }
  }

  private async target(scope: TenantScope, userId: string): Promise<UserRow> {
    const target = await scope.scoped(users).findById(userId);
    if (!target) throw new NotFoundException('User not found');
    return target;
  }

  /**
   * Serialises role and active changes in this shop for the transaction, so
   * concurrent requests can't leave the shop without an active owner.
   */
  private async lockOwners({ tx, tenantId }: TenantScope): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`owners:${tenantId}`}))`,
    );
  }

  private async assertAnotherActiveOwner(
    { scoped }: TenantScope,
    exceptUserId: string,
  ): Promise<void> {
    const others = await scoped(users).count(
      and(
        eq(users.role, 'owner'),
        eq(users.isActive, true),
        ne(users.id, exceptUserId),
      ),
    );
    if (others === 0) throw lastOwner();
  }
}
