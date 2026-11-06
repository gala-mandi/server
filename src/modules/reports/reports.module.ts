import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { RatesModule } from '../rates/rates.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/** Read-only shop reports over purchases, sales, payments and the khata. */
@Module({
  imports: [PaymentsModule, RatesModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
