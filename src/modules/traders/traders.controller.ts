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
  CreateTraderDto,
  ListTradersQueryDto,
  LookupTradersQueryDto,
  TraderDetailDto,
  TraderDto,
  TraderListDto,
  TraderLookupDto,
  UpdateTraderDto,
} from './traders.dto';
import { TradersService } from './traders.service';

@ApiTags('traders')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Missing permission' })
@UseGuards(TenantGuard)
@Controller('traders')
export class TradersController {
  constructor(private readonly traders: TradersService) {}

  @Get()
  @Permissions('trader.view')
  @ApiOkResponse({ type: TraderListDto })
  list(@Query() query: ListTradersQueryDto): Promise<TraderListDto> {
    return this.traders.list(query);
  }

  // Before `:id`, so "lookup" is never read as an id.
  @Get('lookup')
  @Permissions('trader.view')
  @ApiOkResponse({
    type: TraderLookupDto,
    description:
      'Active traders matching `q` (name or phone), names starting with it first',
  })
  async lookup(
    @Query() query: LookupTradersQueryDto,
  ): Promise<TraderLookupDto> {
    return { data: await this.traders.lookup(query) };
  }

  @Post()
  @Permissions('trader.create')
  @ApiCreatedResponse({
    type: TraderDto,
    description: 'An opening balance above 0 also writes the first khata entry',
  })
  @ApiBadRequestResponse({ description: 'Field errors' })
  @ApiConflictResponse({ description: 'PHONE_TAKEN in this shop' })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateTraderDto,
  ): Promise<TraderDto> {
    return this.traders.create(dto, user.id);
  }

  @Get(':id')
  @Permissions('trader.view')
  @ApiOkResponse({ type: TraderDetailDto })
  @ApiNotFoundResponse()
  get(@Param('id', ParseUUIDPipe) id: string): Promise<TraderDetailDto> {
    return this.traders.get(id);
  }

  @Patch(':id')
  @Permissions('trader.manage')
  @ApiOkResponse({
    type: TraderDetailDto,
    description:
      'A changed opening balance adds a reversal and a new opening entry',
  })
  @ApiBadRequestResponse({ description: 'Field errors' })
  @ApiConflictResponse({ description: 'PHONE_TAKEN in this shop' })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTraderDto,
  ): Promise<TraderDetailDto> {
    return this.traders.update(id, dto, user.id);
  }

  @Delete(':id')
  @Permissions('trader.delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Soft deleted (owner can restore)' })
  @ApiConflictResponse({
    description: 'TRADER_HAS_TRANSACTIONS: deactivate instead',
  })
  @ApiNotFoundResponse()
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.traders.remove(id);
  }
}
