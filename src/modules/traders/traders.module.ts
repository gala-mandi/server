import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TradersController } from './traders.controller';
import { TradersService } from './traders.service';

@Module({
  imports: [LedgerModule],
  controllers: [TradersController],
  providers: [TradersService],
})
export class TradersModule {}
