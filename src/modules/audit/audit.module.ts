import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditLogsService } from './audit-logs.service';
import { RestorableRegistry } from './restorable-registry';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditLogsService, RestorableRegistry],
  exports: [RestorableRegistry],
})
export class AuditModule {}
