import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import {
  DayRatesDto,
  ListRatesQueryDto,
  RateDateParamDto,
  RateListDto,
  SaveRatesDto,
  TodayRatesDto,
} from './rates.dto';
import { RatesService } from './rates.service';

@ApiTags('rates')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Missing permission' })
@UseGuards(TenantGuard)
@Controller('rates')
export class RatesController {
  constructor(private readonly rates: RatesService) {}

  @Get('today')
  @Permissions('rate.view')
  @ApiOkResponse({
    type: TodayRatesDto,
    description:
      "Today's rates (Asia/Karachi date) and yesterday's, the starting point for today's entry",
  })
  today(): Promise<TodayRatesDto> {
    return this.rates.today();
  }

  @Get()
  @Permissions('rate.view')
  @ApiOkResponse({
    type: RateListDto,
    description:
      'Rate history, filtered by commodity and date range (from/to inclusive)',
  })
  @ApiBadRequestResponse({ description: 'Bad filter' })
  list(@Query() query: ListRatesQueryDto): Promise<RateListDto> {
    return this.rates.list(query);
  }

  @Put(':date')
  @Permissions('rate.manage')
  @ApiParam({ name: 'date', example: '2026-11-06' })
  @ApiOkResponse({
    type: DayRatesDto,
    description:
      "Adds or updates the listed commodities' rates for the day; returns all of that day's rates",
  })
  @ApiBadRequestResponse({
    description: 'Field errors (e.g. min > max, unknown commodity)',
  })
  @ApiForbiddenResponse({
    description: 'A past day, by someone other than the owner or a manager',
  })
  save(
    @CurrentUser() user: AuthUser,
    @Param() { date }: RateDateParamDto,
    @Body() dto: SaveRatesDto,
  ): Promise<DayRatesDto> {
    return this.rates.save(date, dto, user);
  }
}
