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
  CashBookDto,
  CashBookQueryDto,
  CreatePaymentDto,
  IDEMPOTENCY_HEADER,
  idempotencyKeySchema,
  ListPaymentsQueryDto,
  PaymentDto,
  PaymentListDto,
  SavedPaymentDto,
} from './payments.dto';
import { PaymentsService } from './payments.service';

const actorOf = (user: AuthUser) => ({ id: user.id, role: user.role });

@ApiTags('payments')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Missing permission' })
@UseGuards(TenantGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @Permissions('payment.create')
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'Made once per payment form (e.g. a UUID) and sent again on every retry of that save',
  })
  @ApiCreatedResponse({
    type: SavedPaymentDto,
    description:
      'Saved with its voucher number (PAY- paid, RCT- received); the kissan is debited or the beopari credited with the amount. The part no bill takes is an advance; `warnings` has OVERPAYMENT when it is more than the khata owes and the shop allows advances',
  })
  @ApiOkResponse({
    type: SavedPaymentDto,
    description:
      'Already saved with this Idempotency-Key: the same payment (warnings empty)',
  })
  @ApiBadRequestResponse({
    description:
      'Field errors (unknown, inactive or wrong-type trader, a bill of another trader, kind or status, more than a bill has left, future date, missing Idempotency-Key)',
  })
  @ApiConflictResponse({
    description:
      'OVERPAYMENT: more than the khata owes and the shop blocks it (nothing saved)',
  })
  async create(
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreatePaymentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SavedPaymentDto> {
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
    const { payment, replayed } = await this.payments.create(
      dto,
      actorOf(user),
      parsed.data,
    );
    if (replayed) res.status(HttpStatus.OK);
    return payment;
  }

  @Get()
  @Permissions('payment.view')
  @ApiOkResponse({
    type: PaymentListDto,
    description:
      'Newest first; filter by date range (from/to inclusive), direction, trader, method and status',
  })
  @ApiBadRequestResponse({ description: 'Bad filter' })
  list(@Query() query: ListPaymentsQueryDto): Promise<PaymentListDto> {
    return this.payments.list(query);
  }

  // Before `:id`, which would take "cash-book" for an id.
  @Get('cash-book')
  @Permissions('payment.view')
  @ApiOkResponse({
    type: CashBookDto,
    description:
      'Daily cash in (received) and out (paid) of posted cash vouchers, with the cash in hand; from/to default to today',
  })
  @ApiBadRequestResponse({ description: 'Bad date range' })
  cashBook(@Query() query: CashBookQueryDto): Promise<CashBookDto> {
    return this.payments.cashBook(query);
  }

  @Get(':id')
  @Permissions('payment.view')
  @ApiOkResponse({ type: PaymentDto })
  @ApiNotFoundResponse()
  get(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentDto> {
    return this.payments.get(id);
  }

  @Post(':id/cancel')
  @Permissions('payment.delete')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: PaymentDto,
    description:
      'Cancelled instead of deleted: khata reversed, the bills it settled are open again, voucher number kept and never reused',
  })
  @ApiConflictResponse({ description: 'PAYMENT_CANCELLED: already cancelled' })
  @ApiNotFoundResponse()
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PaymentDto> {
    return this.payments.cancel(id, actorOf(user));
  }
}
