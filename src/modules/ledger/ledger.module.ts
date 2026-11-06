import { Module } from '@nestjs/common';
import { LedgerController } from './ledger.controller';
import { LedgerReconciliation } from './ledger-reconciliation.service';
import { LedgerService } from './ledger.service';

/**
 * The khata. Purchases, sales and payments import this module and post
 * through `LedgerService`; each registers its documents with
 * `LedgerReconciliation` so the nightly check can compare them.
 */
@Module({
  controllers: [LedgerController],
  providers: [LedgerService, LedgerReconciliation],
  exports: [LedgerService, LedgerReconciliation],
})
export class LedgerModule {}
