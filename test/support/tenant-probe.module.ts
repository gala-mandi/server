import {
  Body,
  Controller,
  Get,
  Inject,
  Module,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { CurrentTenant } from '../../src/common/decorators/current-tenant.decorator';
import { Roles } from '../../src/common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { TenantGuard } from '../../src/common/guards/tenant.guard';
import { DRIZZLE, type Database } from '../../src/database/database.module';
import { users } from '../../src/database/schema';

/**
 * Test-only shop endpoints. No business endpoints exist yet, so these prove
 * the guards and `@CurrentTenant()` keep shops apart.
 */
@Controller('test-probe')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
class TenantProbeController {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  @Get('users/:id')
  async user(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    const [row] = await this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.id, id), eq(users.tenantId, tenantId)));
    if (!row) throw new NotFoundException('User not found');
    return row;
  }

  @Post('users/:id/rename')
  async rename(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Body() body: { name: string },
  ) {
    const rows = await this.db
      .update(users)
      .set({ name: body.name })
      .where(and(eq(users.id, id), eq(users.tenantId, tenantId)))
      .returning({ id: users.id });
    if (!rows.length) throw new NotFoundException('User not found');
    return rows[0];
  }

  @Post('echo-tenant')
  echo(@CurrentTenant() tenantId: string) {
    return { tenantId };
  }

  @Get('owner-only')
  @Roles('owner')
  ownerOnly() {
    return { ok: true };
  }
}

@Module({ controllers: [TenantProbeController] })
export class TenantProbeModule {}
