import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import {
  AdjustmentDto,
  BalancesDto,
  BalancesQueryDto,
  LedgerEntryDto,
  StatementDto,
  StatementQueryDto,
} from './ledger.dto';
import { LedgerService } from './ledger.service';

@ApiTags('ledger')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Missing permission' })
@UseGuards(TenantGuard)
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  // Before `:traderId`, so "balances" is never read as an id.
  @Get('balances')
  @Permissions('ledger.view')
  @ApiOkResponse({
    type: BalancesDto,
    description:
      'Every trader with balance, receivable (trader owes the shop) and payable (shop owes the trader)',
  })
  balances(@Query() query: BalancesQueryDto): Promise<BalancesDto> {
    return this.ledger.balances(query);
  }

  @Post('adjustments')
  @Roles('owner')
  @ApiCreatedResponse({
    type: LedgerEntryDto,
    description:
      'Owner only. Adds an `adjustment` entry; the reason is its narration',
  })
  @ApiBadRequestResponse({ description: 'Field errors' })
  @ApiNotFoundResponse({ description: 'Trader not in this shop' })
  adjust(
    @CurrentUser() user: AuthUser,
    @Body() dto: AdjustmentDto,
  ): Promise<LedgerEntryDto> {
    return this.ledger.adjust(dto, user.id);
  }

  @Get(':traderId')
  @Permissions('ledger.view')
  @ApiOkResponse({
    type: StatementDto,
    description:
      'Entries from `from` to `to` (both included, optional) in date order, with the opening balance carried from before `from` and the running balance after each entry',
  })
  @ApiBadRequestResponse({ description: 'Invalid dates or paging' })
  @ApiNotFoundResponse({ description: 'Trader not in this shop' })
  statement(
    @Param('traderId', ParseUUIDPipe) traderId: string,
    @Query() query: StatementQueryDto,
  ): Promise<StatementDto> {
    return this.ledger.statement(traderId, query);
  }
}
