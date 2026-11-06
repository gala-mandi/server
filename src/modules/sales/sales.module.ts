import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [LedgerModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
