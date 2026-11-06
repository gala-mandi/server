import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { ShopSubscriptionDto } from './subscriptions.dto';
import { SubscriptionsService } from './subscriptions.service';

@ApiTags('subscription')
@ApiBearerAuth()
@Roles('owner', 'manager', 'operator')
@UseGuards(TenantGuard)
@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get()
  @ApiOkResponse({
    type: ShopSubscriptionDto,
    description:
      "The shop's plan, limits, end date, grace end, days left and access state (for the banner)",
  })
  get(): Promise<ShopSubscriptionDto> {
    return this.subscriptions.forShop();
  }
}
