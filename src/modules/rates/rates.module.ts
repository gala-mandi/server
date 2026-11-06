import { Module } from '@nestjs/common';
import { RatesController } from './rates.controller';
import { RatesService } from './rates.service';

@Module({
  controllers: [RatesController],
  providers: [RatesService],
  // The daily summary report lists the day's rates.
  exports: [RatesService],
})
export class RatesModule {}
