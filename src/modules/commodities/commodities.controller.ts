import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import {
  CommodityDto,
  CommodityListDto,
  CommodityLookupDto,
  CreateCommodityDto,
  ListCommoditiesQueryDto,
  LookupCommoditiesQueryDto,
  UpdateCommodityDto,
} from './commodities.dto';
import { CommoditiesService } from './commodities.service';

@ApiTags('commodities')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Missing permission' })
@UseGuards(TenantGuard)
@Controller('commodities')
export class CommoditiesController {
  constructor(private readonly commodities: CommoditiesService) {}

  @Get()
  @Permissions('commodity.view')
  @ApiOkResponse({ type: CommodityListDto })
  list(@Query() query: ListCommoditiesQueryDto): Promise<CommodityListDto> {
    return this.commodities.list(query);
  }

  // Before `:id`, so "lookup" is never read as an id.
  @Get('lookup')
  @Permissions('commodity.view')
  @ApiOkResponse({
    type: CommodityLookupDto,
    description:
      'Active commodities matching `q` (name or Urdu name), names starting with it first, with the charges that apply (own value, else the shop default)',
  })
  async lookup(
    @Query() query: LookupCommoditiesQueryDto,
  ): Promise<CommodityLookupDto> {
    return { data: await this.commodities.lookup(query) };
  }

  @Post()
  @Permissions('commodity.manage')
  @ApiCreatedResponse({ type: CommodityDto })
  @ApiBadRequestResponse({ description: 'Field errors' })
  @ApiConflictResponse({ description: 'NAME_TAKEN in this shop' })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCommodityDto,
  ): Promise<CommodityDto> {
    return this.commodities.create(dto, user.id);
  }

  @Get(':id')
  @Permissions('commodity.view')
  @ApiOkResponse({ type: CommodityDto })
  @ApiNotFoundResponse()
  get(@Param('id', ParseUUIDPipe) id: string): Promise<CommodityDto> {
    return this.commodities.get(id);
  }

  @Patch(':id')
  @Permissions('commodity.manage')
  @ApiOkResponse({
    type: CommodityDto,
    description: 'A charge set to null (or "") falls back to the shop default',
  })
  @ApiBadRequestResponse({ description: 'Field errors' })
  @ApiConflictResponse({ description: 'NAME_TAKEN in this shop' })
  @ApiNotFoundResponse()
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCommodityDto,
  ): Promise<CommodityDto> {
    return this.commodities.update(id, dto);
  }

  @Delete(':id')
  @Permissions('commodity.delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Soft deleted (owner can restore)' })
  @ApiConflictResponse({
    description:
      'COMMODITY_IN_USE: used in rates, purchases or sales; deactivate instead',
  })
  @ApiNotFoundResponse()
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.commodities.remove(id);
  }
}
