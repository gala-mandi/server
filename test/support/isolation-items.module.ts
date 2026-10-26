import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Roles } from '../../src/common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { TenantGuard } from '../../src/common/guards/tenant.guard';
import { TenantDatabase } from '../../src/database/tenant-database';
import { isolationItems } from './isolation-items';

class ItemBody extends createZodDto(
  z.object({ name: z.string().trim().min(1).max(120) }),
) {}

const uuid = new ParseUUIDPipe({ version: '4' });

/** Unique violation from Postgres, possibly wrapped by Drizzle. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

async function uniqueName<R>(write: () => Promise<R>): Promise<R> {
  try {
    return await write();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictException('Name already used in this shop');
    }
    throw error;
  }
}

/**
 * Test-only CRUD on `test_isolation_items`, written the way a real business
 * module must be: every query through `TenantDatabase` and `scoped()`; the
 * shop never comes from the request.
 */
@Controller('test-items')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Roles('owner', 'manager', 'operator')
class IsolationItemsController {
  constructor(private readonly db: TenantDatabase) {}

  @Get()
  list() {
    return this.db.transaction(async ({ scoped }) => {
      const items = scoped(isolationItems);
      return {
        data: await items.findMany(),
        meta: { total: await items.count() },
      };
    });
  }

  @Get(':id')
  async get(@Param('id', uuid) id: string) {
    const row = await this.db.transaction(({ scoped }) =>
      scoped(isolationItems).findById(id),
    );
    if (!row) throw new NotFoundException('Item not found');
    return row;
  }

  @Post()
  create(@Body() body: ItemBody) {
    return uniqueName(() =>
      this.db.transaction(async ({ scoped }) => {
        const [row] = await scoped(isolationItems).insert({ ...body });
        return row;
      }),
    );
  }

  @Patch(':id')
  async update(@Param('id', uuid) id: string, @Body() body: ItemBody) {
    const [row] = await uniqueName(() =>
      this.db.transaction(({ scoped }) =>
        scoped(isolationItems).update(id, { ...body }),
      ),
    );
    if (!row) throw new NotFoundException('Item not found');
    return row;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', uuid) id: string): Promise<void> {
    const [row] = await this.db.transaction(({ scoped }) =>
      scoped(isolationItems).softDelete(id),
    );
    if (!row) throw new NotFoundException('Item not found');
  }
}

/** A raw query that "forgets" the helper: only RLS limits it. */
@Controller('test-items-raw')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
class IsolationItemsRawController {
  constructor(private readonly db: TenantDatabase) {}

  @Get()
  async list() {
    const result = await this.db.transaction(({ tx }) =>
      tx.execute(sql`select * from test_isolation_items`),
    );
    return { data: result.rows };
  }
}

/** Super-admin reading a shop through `withTenant()`. */
@Controller('admin-test/tenants')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('super_admin')
class IsolationItemsAdminController {
  constructor(private readonly db: TenantDatabase) {}

  @Get(':tenantId/items')
  async list(@Param('tenantId', uuid) tenantId: string) {
    const data = await this.db.withTenant(tenantId, ({ scoped }) =>
      scoped(isolationItems).findMany(),
    );
    return { data };
  }
}

@Module({
  controllers: [
    IsolationItemsController,
    IsolationItemsRawController,
    IsolationItemsAdminController,
  ],
})
export class IsolationItemsModule {}
