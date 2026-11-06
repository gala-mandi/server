import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
  AssignSubscriptionDto,
  ExtendSubscriptionDto,
  SubscriptionViewDto,
} from './subscriptions.dto';
import { SubscriptionsService } from './subscriptions.service';

@ApiTags('admin: shops')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Super-admin only' })
@Permissions('plan.manage')
@Controller('admin/tenants/:id/subscription')
export class AdminSubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Post()
  @ApiCreatedResponse({
    type: SubscriptionViewDto,
    description:
      'Puts the shop on a plan for a period; its running subscription is cancelled (replaced)',
  })
  @ApiBadRequestResponse({ description: 'Field errors' })
  @ApiConflictResponse({ description: 'PLAN_INACTIVE' })
  @ApiNotFoundResponse()
  assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignSubscriptionDto,
  ): Promise<SubscriptionViewDto> {
    return this.subscriptions.assign(id, dto);
  }

  @Patch()
  @ApiOkResponse({
    type: SubscriptionViewDto,
    description:
      'New end date for the current subscription; full access returns at once',
  })
  @ApiBadRequestResponse({ description: 'Field errors' })
  @ApiConflictResponse({ description: 'NO_SUBSCRIPTION' })
  @ApiNotFoundResponse()
  extend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExtendSubscriptionDto,
  ): Promise<SubscriptionViewDto> {
    return this.subscriptions.extend(id, dto);
  }
}
