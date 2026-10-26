import {
  Controller,
  Get,
  Module,
  type OnModuleInit,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Roles } from '../../src/common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { TenantGuard } from '../../src/common/guards/tenant.guard';
import { TenantDatabase } from '../../src/database/tenant-database';
import { RestorableRegistry } from '../../src/modules/audit/restorable-registry';
import { ISOLATION_TABLE } from './isolation-table';
import { isolationItems } from './isolation-items';

/**
 * "Deleted trader's old purchases still show the trader name in reports":
 * a report reads with `whereWithDeleted()`, a normal read with `findById()`.
 */
@Controller('test-items-report')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Roles('owner', 'manager', 'operator')
class AuditReportController {
  constructor(private readonly db: TenantDatabase) {}

  @Get(':id')
  find(@Param('id', ParseUUIDPipe) id: string) {
    return this.db.transaction(async ({ tx, scoped }) => {
      const items = scoped(isolationItems);
      const [report] = await tx
        .select({ id: isolationItems.id, name: isolationItems.name })
        .from(isolationItems)
        .where(items.whereWithDeleted(eq(isolationItems.id, id)));
      return {
        report: report ?? null,
        findById: await items.findById(id),
      };
    });
  }
}

/** Makes `test_isolation_items` restorable, the way a business module does. */
@Module({ controllers: [AuditReportController] })
export class AuditTestModule implements OnModuleInit {
  constructor(private readonly registry: RestorableRegistry) {}

  onModuleInit(): void {
    this.registry.register(ISOLATION_TABLE, isolationItems);
  }
}
