import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { TenantDatabase } from '../../database/tenant-database';
import {
  AuditLogPageDto,
  AuditLogQueryDto,
  RestoreResultDto,
} from './audit-logs.dto';
import { AuditLogsService } from './audit-logs.service';
import { RestorableRegistry } from './restorable-registry';

@ApiTags('audit')
@ApiBearerAuth()
@Controller()
export class AuditController {
  constructor(
    private readonly auditLogs: AuditLogsService,
    private readonly registry: RestorableRegistry,
    private readonly tenantDb: TenantDatabase,
  ) {}

  @Get('audit-logs')
  @Permissions('audit.view')
  @UseGuards(TenantGuard)
  @ApiOkResponse({ type: AuditLogPageDto, description: 'This shop only' })
  @ApiForbiddenResponse()
  list(@Query() query: AuditLogQueryDto): Promise<AuditLogPageDto> {
    return this.auditLogs.list(query);
  }

  @Get('admin/tenants/:tenantId/audit-logs')
  @Permissions('tenant.manage')
  @ApiOkResponse({
    type: AuditLogPageDto,
    description: 'Super-admin; the access is itself written to the log',
  })
  @ApiNotFoundResponse({ description: 'Shop not found' })
  listForTenant(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: AuditLogQueryDto,
  ): Promise<AuditLogPageDto> {
    return this.auditLogs.listForTenant(tenantId, query);
  }

  @Post('records/:entity/:id/restore')
  @HttpCode(HttpStatus.OK)
  @Roles('owner')
  @UseGuards(TenantGuard)
  @ApiOkResponse({ type: RestoreResultDto })
  @ApiNotFoundResponse({
    description: 'Unknown record type or nothing to restore',
  })
  async restore(
    @Param('entity') entity: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RestoreResultDto> {
    const table = this.registry.get(entity);
    if (!table) throw new NotFoundException('Unknown record type');

    const row = await this.tenantDb
      .transaction(({ scoped }) => scoped(table).restore(id))
      .catch((error: unknown) => {
        // A live row now has the same unique value (e.g. same name).
        if (isUniqueViolation(error)) {
          throw new ConflictException(
            'A record with the same details exists; change it first',
          );
        }
        throw error;
      });
    if (!row) throw new NotFoundException('Nothing to restore');
    return { id, restored: true };
  }
}

function isUniqueViolation(error: unknown): boolean {
  const pgCode = (e: unknown) =>
    typeof e === 'object' && e !== null
      ? (e as { code?: unknown }).code
      : undefined;
  const cause =
    typeof error === 'object' && error !== null
      ? (error as { cause?: unknown }).cause
      : undefined;
  return pgCode(error) === '23505' || pgCode(cause) === '23505';
}
