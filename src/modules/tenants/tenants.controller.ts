import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permissions } from '../../common/decorators/permissions.decorator';
import {
  CreateTenantDto,
  CreatedTenantDto,
  ListTenantsQueryDto,
  TenantDetailDto,
  TenantPageDto,
  UpdateTenantDto,
} from './tenants.dto';
import { TenantsService } from './tenants.service';

@ApiTags('admin: shops')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Super-admin only' })
@Permissions('tenant.manage')
@Controller('admin/tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @ApiOkResponse({ type: TenantPageDto })
  list(@Query() query: ListTenantsQueryDto): Promise<TenantPageDto> {
    return this.tenants.list(query);
  }

  @Post()
  @ApiCreatedResponse({
    type: CreatedTenantDto,
    description: "Shop, owner and settings; the owner's password is shown once",
  })
  @ApiConflictResponse({ description: 'PHONE_TAKEN | EMAIL_TAKEN' })
  create(@Body() dto: CreateTenantDto): Promise<CreatedTenantDto> {
    return this.tenants.create(dto);
  }

  @Get(':id')
  @ApiOkResponse({ type: TenantDetailDto })
  @ApiNotFoundResponse()
  get(@Param('id', ParseUUIDPipe) id: string): Promise<TenantDetailDto> {
    return this.tenants.get(id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: TenantDetailDto })
  @ApiNotFoundResponse()
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTenantDto,
  ): Promise<TenantDetailDto> {
    return this.tenants.update(id, dto);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: TenantDetailDto,
    description: "Ends every session of the shop's users",
  })
  @ApiNotFoundResponse()
  suspend(@Param('id', ParseUUIDPipe) id: string): Promise<TenantDetailDto> {
    return this.tenants.suspend(id);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: TenantDetailDto })
  @ApiNotFoundResponse()
  activate(@Param('id', ParseUUIDPipe) id: string): Promise<TenantDetailDto> {
    return this.tenants.activate(id);
  }
}
