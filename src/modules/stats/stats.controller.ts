import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permissions } from '../../common/decorators/permissions.decorator';
import {
  ActivityFeedDto,
  ActivityQueryDto,
  InactiveShopPageDto,
  InactiveShopsQueryDto,
  NewShopsDto,
  NewShopsQueryDto,
  PlatformStatsDto,
} from './stats.dto';
import { StatsService } from './stats.service';

@ApiTags('admin: stats')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Super-admin only' })
@Permissions('platform_report.view')
@Controller('admin/stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  @ApiOkResponse({
    type: PlatformStatsDto,
    description: 'Shops by status and user counts',
  })
  summary(): Promise<PlatformStatsDto> {
    return this.stats.summary();
  }

  @Get('new-shops')
  @ApiOkResponse({
    type: NewShopsDto,
    description: 'Shops created per month (Asia/Karachi), oldest first',
  })
  newShops(@Query() query: NewShopsQueryDto): Promise<NewShopsDto> {
    return this.stats.newShops(query);
  }

  @Get('activity')
  @ApiOkResponse({
    type: ActivityFeedDto,
    description: 'Latest audit log rows of all shops, without their values',
  })
  activity(@Query() query: ActivityQueryDto): Promise<ActivityFeedDto> {
    return this.stats.activity(query);
  }

  @Get('inactive-shops')
  @ApiOkResponse({
    type: InactiveShopPageDto,
    description: 'Trial and active shops with no activity in 14 days',
  })
  inactiveShops(
    @Query() query: InactiveShopsQueryDto,
  ): Promise<InactiveShopPageDto> {
    return this.stats.inactiveShops(query);
  }
}
