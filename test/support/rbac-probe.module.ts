import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthUser } from '../../src/common/auth/auth-user';
import { ALL_ROLES, type Permission } from '../../src/common/auth/permissions';
import { CurrentUser } from '../../src/common/decorators/current-user.decorator';
import { Permissions } from '../../src/common/decorators/permissions.decorator';
import { Roles } from '../../src/common/decorators/roles.decorator';
import { TenantGuard } from '../../src/common/guards/tenant.guard';
import { userRole } from '../../src/database/schema';
import {
  type ShopRole,
  UserRolesService,
} from '../../src/modules/users/user-roles.service';
import { UsersModule } from '../../src/modules/users/users.module';

/** One probe route per permission group; used to build the role matrix. */
export interface ProbeRoute {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  permission: Permission;
  /** Shop route: also behind `TenantGuard`. */
  shop: boolean;
  /** Status when allowed. */
  ok: 200 | 201;
}

const ID = '00000000-0000-4000-8000-000000000000';

export const PROBE_ROUTES: readonly ProbeRoute[] = [
  {
    method: 'post',
    path: '/rbac-probe/purchases',
    permission: 'purchase.create',
    shop: true,
    ok: 201,
  },
  {
    method: 'patch',
    path: `/rbac-probe/purchases/${ID}`,
    permission: 'purchase.edit',
    shop: true,
    ok: 200,
  },
  {
    method: 'delete',
    path: `/rbac-probe/purchases/${ID}`,
    permission: 'purchase.delete',
    shop: true,
    ok: 200,
  },
  {
    method: 'get',
    path: '/rbac-probe/staff',
    permission: 'staff.manage',
    shop: true,
    ok: 200,
  },
  {
    method: 'patch',
    path: '/rbac-probe/settings',
    permission: 'settings.manage',
    shop: true,
    ok: 200,
  },
  {
    method: 'get',
    path: '/rbac-probe/reports',
    permission: 'report.view',
    shop: true,
    ok: 200,
  },
  {
    method: 'get',
    path: '/rbac-probe/rates',
    permission: 'rate.view',
    shop: true,
    ok: 200,
  },
  {
    method: 'post',
    path: '/rbac-probe/rates',
    permission: 'rate.manage',
    shop: true,
    ok: 201,
  },
  {
    method: 'get',
    path: '/rbac-probe/audit',
    permission: 'audit.view',
    shop: true,
    ok: 200,
  },
  {
    method: 'get',
    path: '/rbac-probe/admin/tenants',
    permission: 'tenant.manage',
    shop: false,
    ok: 200,
  },
];

const ok = () => ({ ok: true });

class ChangeRoleBody extends createZodDto(
  z.object({ role: z.enum(userRole.enumValues) }),
) {}

/**
 * Test-only shop endpoints. No `JwtAuthGuard` / `RolesGuard` here: they
 * prove the global guards from `AppModule` protect every route.
 */
@Controller('rbac-probe')
@UseGuards(TenantGuard)
class RbacShopProbeController {
  constructor(private readonly roles: UserRolesService) {}

  @Post('purchases')
  @Permissions('purchase.create')
  createPurchase() {
    return ok();
  }

  @Patch('purchases/:id')
  @Permissions('purchase.edit')
  editPurchase() {
    return ok();
  }

  @Delete('purchases/:id')
  @Permissions('purchase.delete')
  deletePurchase() {
    return ok();
  }

  @Get('staff')
  @Permissions('staff.manage')
  staff() {
    return ok();
  }

  @Patch('staff/:id/role')
  @Permissions('staff.manage')
  changeRole(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ChangeRoleBody,
  ) {
    return this.roles.changeRole(user, id, body.role as ShopRole);
  }

  @Patch('settings')
  @Permissions('settings.manage')
  settings() {
    return ok();
  }

  @Get('reports')
  @Permissions('report.view')
  reports() {
    return ok();
  }

  @Get('rates')
  @Permissions('rate.view')
  rates() {
    return ok();
  }

  @Post('rates')
  @Permissions('rate.manage')
  setRate() {
    return ok();
  }

  @Get('audit')
  @Permissions('audit.view')
  audit() {
    return ok();
  }

  /** Any role, but a shop must be selected. */
  @Get('shop')
  @Roles(...ALL_ROLES)
  shop() {
    return ok();
  }
}

@Controller('rbac-probe')
class RbacOpenProbeController {
  @Get('admin/tenants')
  @Permissions('tenant.manage')
  tenants() {
    return ok();
  }

  /** No access metadata at all: still needs a token. */
  @Get('undecorated')
  undecorated() {
    return ok();
  }
}

@Module({
  imports: [UsersModule],
  controllers: [RbacShopProbeController, RbacOpenProbeController],
})
export class RbacProbeModule {}
