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
  CreateSaleDto,
  IDEMPOTENCY_HEADER,
  idempotencyKeySchema,
  ListSalesQueryDto,
  SaleDto,
  SaleListDto,
  SavedSaleDto,
  UpdateSaleDto,
} from './sales.dto';
import { SalesService } from './sales.service';

const actorOf = (user: AuthUser) => ({ id: user.id, role: user.role });

const CREDIT_LIMIT_DOC =
  'CREDIT_LIMIT_EXCEEDED: the save would take the beopari above their credit limit and the shop blocks it (nothing saved)';

@ApiTags('sales')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Missing permission' })
@UseGuards(TenantGuard)
@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Post()
  @Permissions('sale.create')
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'Made once per sale form (e.g. a UUID) and sent again on every retry of that save',
  })
  @ApiCreatedResponse({
    type: SavedSaleDto,
    description:
      'Saved with its bill number; the beopari is debited with the net amount (and credited with any amount received). `warnings` has CREDIT_LIMIT_EXCEEDED when the shop only warns',
  })
  @ApiOkResponse({
    type: SavedSaleDto,
    description:
      'Already saved with this Idempotency-Key: the same sale (warnings empty)',
  })
  @ApiBadRequestResponse({
    description:
      'Field errors (inactive or unknown beopari, commodity or lot, future date, received above net, missing Idempotency-Key)',
  })
  @ApiConflictResponse({ description: CREDIT_LIMIT_DOC })
  async create(
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateSaleDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SavedSaleDto> {
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
    const { sale, replayed } = await this.sales.create(
      dto,
      actorOf(user),
      parsed.data,
    );
    if (replayed) res.status(HttpStatus.OK);
    return sale;
  }

  @Get()
  @Permissions('sale.view')
  @ApiOkResponse({
    type: SaleListDto,
    description:
      'Newest first; filter by date range (from/to inclusive), beopari, commodity and status',
  })
  @ApiBadRequestResponse({ description: 'Bad filter' })
  list(@Query() query: ListSalesQueryDto): Promise<SaleListDto> {
    return this.sales.list(query);
  }

  @Get(':id')
  @Permissions('sale.view')
  @ApiOkResponse({ type: SaleDto })
  @ApiNotFoundResponse()
  get(@Param('id', ParseUUIDPipe) id: string): Promise<SaleDto> {
    return this.sales.get(id);
  }

  @Patch(':id')
  @Permissions('sale.edit')
  @ApiOkResponse({
    type: SavedSaleDto,
    description:
      'Recalculated; the khata lines are reversed and posted again. Audited with the old values',
  })
  @ApiBadRequestResponse({ description: 'Field errors' })
  @ApiForbiddenResponse({
    description: 'DAY_CLOSED: a day before today, by anyone but the owner',
  })
  @ApiConflictResponse({
    description: `SALE_CANCELLED, or ${CREDIT_LIMIT_DOC}`,
  })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSaleDto,
  ): Promise<SavedSaleDto> {
    return this.sales.update(id, dto, actorOf(user));
  }

  @Post(':id/cancel')
  @Permissions('sale.delete')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: SaleDto,
    description:
      'Cancelled instead of deleted: khata reversed, bill number kept and never reused',
  })
  @ApiConflictResponse({ description: 'SALE_CANCELLED: already cancelled' })
  @ApiNotFoundResponse()
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SaleDto> {
    return this.sales.cancel(id, actorOf(user));
  }
}
