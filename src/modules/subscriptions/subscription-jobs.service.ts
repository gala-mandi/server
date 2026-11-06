import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  karachiDate,
  addDays,
  SHOP_TIME_ZONE,
} from '../../common/time/karachi-date';
import { PlatformDatabase } from '../../database/platform-database';
import { auditLogs, tenantSubscriptions, tenants } from '../../database/schema';
import { REMINDER_DAYS } from './access-state';

export interface DailyRunResult {
  /** Subscriptions whose end date passed today (status → expired). */
  expired: number;
  /** Reminders sent today (7, 3 and 1 days before the end date). */
  reminded: number;
}

/**
 * Once a day (00:05 Pakistan time): marks lapsed subscriptions `expired` and
 * reminds shops 7, 3 and 1 days before their plan ends. Running it twice the
 * same day changes nothing the second time: expiry only touches `active`
 * rows, and each reminder is written to `audit_logs` (action `remind`) and
 * looked up there before it is sent again.
 *
 * There is no SMS/WhatsApp provider yet (the OTP and invite senders only log),
 * so a reminder is logged and audited; the shop panel banner shows the days
 * left to every user.
 */
@Injectable()
export class SubscriptionJobsService {
  private readonly logger = new Logger('SubscriptionJobs');

  constructor(private readonly platform: PlatformDatabase) {}

  @Cron('0 5 0 * * *', {
    name: 'subscriptions-daily',
    timeZone: SHOP_TIME_ZONE,
  })
  async daily(): Promise<void> {
    const result = await this.run();
    this.logger.log(
      `Daily subscriptions check: ${result.expired} expired, ${result.reminded} reminded`,
    );
  }

  run(today: string = karachiDate()): Promise<DailyRunResult> {
    return this.platform.scheduledTransaction(async ({ tx, audit }) => {
      // One run at a time, even with several API instances.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('subscriptions-daily'))`,
      );

      const expired = await tx
        .update(tenantSubscriptions)
        .set({ status: 'expired' })
        .where(
          and(
            eq(tenantSubscriptions.status, 'active'),
            lt(tenantSubscriptions.endsOn, today),
          ),
        )
        .returning({
          id: tenantSubscriptions.id,
          tenantId: tenantSubscriptions.tenantId,
        });
      for (const row of expired) {
        await audit({
          tenantId: row.tenantId,
          entity: 'tenant_subscriptions',
          entityId: row.id,
          action: 'update',
          before: { status: 'active' },
          after: { status: 'expired' },
        });
      }

      const due = await tx
        .select({
          id: tenantSubscriptions.id,
          tenantId: tenantSubscriptions.tenantId,
          endsOn: tenantSubscriptions.endsOn,
          shopName: tenants.name,
        })
        .from(tenantSubscriptions)
        .innerJoin(tenants, eq(tenants.id, tenantSubscriptions.tenantId))
        .where(
          and(
            eq(tenantSubscriptions.status, 'active'),
            inArray(
              tenantSubscriptions.endsOn,
              REMINDER_DAYS.map((d) => addDays(today, d)),
            ),
          ),
        );

      let reminded = 0;
      for (const sub of due) {
        const daysLeft = REMINDER_DAYS.find(
          (d) => addDays(today, d) === sub.endsOn,
        )!;
        const [sent] = await tx
          .select({ id: auditLogs.id })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.tenantId, sub.tenantId),
              eq(auditLogs.entity, 'tenant_subscriptions'),
              eq(auditLogs.entityId, sub.id),
              eq(auditLogs.action, 'remind'),
              sql`${auditLogs.after}->>'endsOn' = ${sub.endsOn}`,
              sql`(${auditLogs.after}->>'daysLeft')::int = ${daysLeft}`,
            ),
          )
          .limit(1);
        if (sent) continue;

        this.logger.warn(
          `Reminder: the plan of ${sub.shopName} ends on ${sub.endsOn} (${daysLeft} day(s) left). No messaging provider configured; shown in the shop panel banner.`,
        );
        await audit({
          tenantId: sub.tenantId,
          entity: 'tenant_subscriptions',
          entityId: sub.id,
          action: 'remind',
          after: { endsOn: sub.endsOn, daysLeft, channel: 'banner' },
        });
        reminded += 1;
      }

      return { expired: expired.length, reminded };
    });
  }
}
