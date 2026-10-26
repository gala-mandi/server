import { Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE, type Database } from '../../database/database.module';
import { authLogs } from '../../database/schema';
import type { RequestMeta } from './request-meta';

export type AuthAction =
  'login' | 'logout' | 'failed' | 'refresh' | 'locked' | 'reset';

export interface AuthLogEntry {
  action: AuthAction;
  userId?: string | null;
  tenantId?: string | null;
  meta: RequestMeta;
}

/** Writes `auth_logs`. Never receives passwords, tokens or codes. */
@Injectable()
export class AuthLogService {
  private readonly logger = new Logger(AuthLogService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async write({ action, userId, tenantId, meta }: AuthLogEntry): Promise<void> {
    try {
      await this.db.insert(authLogs).values({
        action,
        userId: userId ?? null,
        tenantId: tenantId ?? null,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    } catch (error) {
      // A logging failure must not block sign-in.
      this.logger.error(`Could not write auth log: ${String(error)}`);
    }
  }
}
