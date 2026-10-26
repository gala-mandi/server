import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import type { AuthUser, Role } from '../../common/auth/auth-user';
import { roleHas } from '../../common/auth/permissions';
import { users } from '../../database/schema';
import { TenantDatabase } from '../../database/tenant-database';

export type ShopRole = Exclude<Role, 'super_admin'>;

/**
 * Changes a staff member's role inside the actor's shop. The new role is in
 * the user's next access token, i.e. after their next refresh.
 * Used by the staff screens (staff ticket); no endpoint yet.
 */
@Injectable()
export class UserRolesService {
  constructor(private readonly tenantDb: TenantDatabase) {}

  async changeRole(
    actor: AuthUser,
    userId: string,
    role: ShopRole,
  ): Promise<{ id: string; role: ShopRole }> {
    if (!roleHas(actor.role, 'staff.manage')) {
      throw new ForbiddenException('You do not have access to this action');
    }
    if ((role as Role) === 'super_admin') {
      throw new BadRequestException('Shop users cannot be platform admins');
    }

    return this.tenantDb.transaction(async ({ scoped }) => {
      const shopUsers = scoped(users);
      const target = await shopUsers.findById(userId);
      if (!target) throw new NotFoundException('User not found');
      if (target.role === role) return { id: target.id, role };

      if (target.role === 'owner') {
        const otherOwners = await shopUsers.count(
          and(
            eq(users.role, 'owner'),
            eq(users.isActive, true),
            ne(users.id, target.id),
          ),
        );
        // A disabled owner can't run the shop, so only active ones count.
        if (otherOwners === 0) {
          throw new BadRequestException({
            message: 'A shop needs at least one owner',
            errors: [
              { field: 'role', message: 'A shop needs at least one owner' },
            ],
          });
        }
      }

      await shopUsers.update(target.id, { role });
      return { id: target.id, role };
    });
  }
}
