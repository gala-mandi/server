import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import {
  CreatePurchaseDto,
  IDEMPOTENCY_HEADER,
  idempotencyKeySchema,
  ListPurchasesQueryDto,
  PurchaseDto,
  PurchaseListDto,
  UpdatePurchaseDto,
} from './purchases.dto';
import { PurchasesService } from './purchases.service';

const actorOf = (user: AuthUser) => ({ id: user.id, role: user.role });

@ApiTags('purchases')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Missing permission' })
@UseGuards(TenantGuard)
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Post()
  @Permissions('purchase.create')
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'Made once per purchase form (e.g. a UUID) and sent again on every retry of that save',
  })
  @ApiCreatedResponse({
    type: PurchaseDto,
    description:
      'Saved with its bill number; the kissan is credited with the net amount (and debited with any amount paid)',
  })
  @ApiOkResponse({
    type: PurchaseDto,
    description: 'Already saved with this Idempotency-Key: the same purchase',
  })
  @ApiBadRequestResponse({
    description:
      'Field errors (inactive or unknown kissan or commodity, future date, paid above net, missing Idempotency-Key)',
  })
  async create(
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreatePurchaseDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseDto> {
    const parsed = idempotencyKeySchema.safeParse(key);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [
          {
            field: IDEMPOTENCY_HEADER,
            message: parsed.error.issues[0].message,
          },
        ],
      });
    }
    const { purchase, replayed } = await this.purchases.create(
      dto,
      actorOf(user),
      parsed.data,
    );
    if (replayed) res.status(HttpStatus.OK);
    return purchase;
  }

  @Get()
  @Permissions('purchase.view')
  @ApiOkResponse({
    type: PurchaseListDto,
    description:
      'Newest first; filter by date range (from/to inclusive), kissan, commodity and status',
  })
  @ApiBadRequestResponse({ description: 'Bad filter' })
  list(@Query() query: ListPurchasesQueryDto): Promise<PurchaseListDto> {
    return this.purchases.list(query);
  }

  @Get(':id')
  @Permissions('purchase.view')
  @ApiOkResponse({ type: PurchaseDto })
  @ApiNotFoundResponse()
  get(@Param('id', ParseUUIDPipe) id: string): Promise<PurchaseDto> {
    return this.purchases.get(id);
  }

  @Patch(':id')
  @Permissions('purchase.edit')
  @ApiOkResponse({
    type: PurchaseDto,
    description:
      'Recalculated; the khata lines are reversed and posted again. Audited with the old values',
  })
  @ApiBadRequestResponse({ description: 'Field errors' })
  @ApiForbiddenResponse({
    description: 'DAY_CLOSED: a day before today, by anyone but the owner',
  })
  @ApiConflictResponse({ description: 'PURCHASE_CANCELLED' })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseDto,
  ): Promise<PurchaseDto> {
    return this.purchases.update(id, dto, actorOf(user));
  }

  @Post(':id/cancel')
  @Permissions('purchase.delete')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: PurchaseDto,
    description:
      'Cancelled instead of deleted: khata reversed, bill number kept and never reused',
  })
  @ApiConflictResponse({ description: 'PURCHASE_CANCELLED: already cancelled' })
  @ApiNotFoundResponse()
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PurchaseDto> {
    return this.purchases.cancel(id, actorOf(user));
  }
}
