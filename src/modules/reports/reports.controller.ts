import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import {
  BookReportQueryDto,
  CashBookReportDto,
  CommissionReportDto,
  DailySummaryDto,
  DailySummaryQueryDto,
  MAX_REPORT_DAYS,
  OutstandingQueryDto,
  OutstandingReportDto,
  PurchasesReportDto,
  ReportRangeQueryDto,
  SalesReportDto,
} from './reports.dto';
import { ReportsService } from './reports.service';

const RANGE = `from/to are YYYY-MM-DD (Asia/Karachi), both included; to defaults to today and from to to; at most ${MAX_REPORT_DAYS} days`;

/** Owner and manager only (`report.view`); operators get 403. */
@ApiTags('reports')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Missing permission (operators)' })
@UseGuards(TenantGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('daily-summary')
  @Permissions('report.view')
  @ApiOkResponse({
    type: DailySummaryDto,
    description:
      "One day (default today): posted purchases and sales, commission, vouchers, the cash book, the day's cancelled documents (left out of the totals) and rates",
  })
  @ApiBadRequestResponse({ description: 'Bad date' })
  dailySummary(@Query() query: DailySummaryQueryDto): Promise<DailySummaryDto> {
    return this.reports.dailySummary(query);
  }

  @Get('purchases')
  @Permissions('report.view')
  @ApiOkResponse({
    type: PurchasesReportDto,
    description: `Posted purchases grouped by day, commodity or trader, with totals. ${RANGE}. Deductions and net are null where bills are split by commodity`,
  })
  @ApiBadRequestResponse({ description: 'Bad filter or date range' })
  purchases(@Query() query: BookReportQueryDto): Promise<PurchasesReportDto> {
    return this.reports.purchases(query);
  }

  @Get('sales')
  @Permissions('report.view')
  @ApiOkResponse({
    type: SalesReportDto,
    description: `Posted sales grouped by day, commodity or trader, with totals. ${RANGE}. Charges and net are null where bills are split by commodity`,
  })
  @ApiBadRequestResponse({ description: 'Bad filter or date range' })
  sales(@Query() query: BookReportQueryDto): Promise<SalesReportDto> {
    return this.reports.sales(query);
  }

  @Get('commission')
  @Permissions('report.view')
  @ApiOkResponse({
    type: CommissionReportDto,
    description: `Commission charged on posted purchases and sales, per day and in total; market fee, labour and other charges shown apart (not income). ${RANGE}`,
  })
  @ApiBadRequestResponse({ description: 'Bad date range' })
  commission(
    @Query() query: ReportRangeQueryDto,
  ): Promise<CommissionReportDto> {
    return this.reports.commission(query);
  }

  @Get('outstanding')
  @Permissions('report.view')
  @ApiOkResponse({
    type: OutstandingReportDto,
    description:
      'Khata balances: receivable (traders owe the shop) and payable (the shop owes them), largest first, at the end of asOf (default: now)',
  })
  @ApiBadRequestResponse({ description: 'Bad filter' })
  outstanding(
    @Query() query: OutstandingQueryDto,
  ): Promise<OutstandingReportDto> {
    return this.reports.outstanding(query);
  }

  @Get('cash-book')
  @Permissions('report.view')
  @ApiOkResponse({
    type: CashBookReportDto,
    description: `The cash book of GET /payments/cash-book: opening cash, daily cash in and out of posted cash vouchers, closing cash. ${RANGE}`,
  })
  @ApiBadRequestResponse({ description: 'Bad date range' })
  cashBook(@Query() query: ReportRangeQueryDto): Promise<CashBookReportDto> {
    return this.reports.cashBook(query);
  }
}
