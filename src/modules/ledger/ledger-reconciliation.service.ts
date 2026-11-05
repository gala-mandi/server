import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type SQL, sql } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../../common/context/request-context';
import type { Env } from '../../config/env.schema';
import {
  PlatformDatabase,
  type PlatformScope,
} from '../../database/platform-database';
import type { SourceType } from './ledger.dto';

/** Documents of one kind and what each must have put in the khata. */
export interface ReconciliationSource {
  sourceType: Exclude<SourceType, 'adjustment' | 'reversal'>;
  /**
   * A query over all shops returning one row per document and trader:
   * `tenant_id`, `trader_id`, `source_id` and `net`, the debit minus credit
   * the khata must hold for it (0 for a cancelled document).
   */
  expected: SQL;
}

export interface LedgerMismatch {
  /**
   * - `document`: a document's entries don't add up to the document
   * - `unexplained`: entries no registered document or adjustment explains
   * - `daily_balance`: a day's snapshot differs from that day's entries
   */
  check: 'document' | 'unexplained' | 'daily_balance';
  tenantId: string;
  traderId: string;
  sourceType: string | null;
  sourceId: string | null;
  entryDate: string | null;
  /**
   * Debit minus credit; for `daily_balance` "debit/credit". `expected` is
   * what the documents (or the entries) say, `actual` what the khata (or
   * the snapshot) has.
   */
  expected: string;
  actual: string;
}

export interface ReconciliationResult {
  ok: boolean;
  checkedAt: string;
  mismatches: LedgerMismatch[];
}

/** Rows each check returns at most; one is enough to fail. */
const MAX_ROWS = 1000;
/** 02:00 in Pakistan (UTC+5, no daylight saving) is 21:00 UTC. */
const RUN_AT_UTC_HOUR = 21;

/**
 * The reconciliation check: the sum of the documents equals the sum of the
 * khata, and the daily snapshots equal the entries. Runs every night and logs
 * an error (the alert) on any mismatch.
 *
 * It is a system job with no request and no shop, so it runs as the
 * platform (`PlatformDatabase`, no RLS) across all shops, in a read-only
 * transaction: it never changes anything.
 */
@Injectable()
export class LedgerReconciliation
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(LedgerReconciliation.name);
  private readonly sources = new Map<string, ReconciliationSource>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly platform: PlatformDatabase,
    private readonly cls: ClsService<RequestContext>,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Called by each document module in `onModuleInit`. */
  register(source: ReconciliationSource): void {
    this.sources.set(source.sourceType, source);
  }

  onApplicationBootstrap(): void {
    // Tests call run() themselves.
    if (this.config.get('NODE_ENV', { infer: true }) !== 'test') {
      this.scheduleNext();
    }
  }

  onApplicationShutdown(): void {
    clearTimeout(this.timer);
  }

  /**
   * Runs every check; `tenantIds` limits it to those shops (tests).
   * Logs an error listing the mismatches when there are any.
   */
  async run(tenantIds?: string[]): Promise<ReconciliationResult> {
    const mismatches = await this.cls.run(() => {
      this.cls.set('role', 'super_admin');
      return this.platform.transaction(async ({ tx }) => {
        await tx.execute(sql`set transaction read only`);
        const found: LedgerMismatch[] = [];
        for (const source of this.sources.values()) {
          found.push(...(await this.checkDocuments(tx, source, tenantIds)));
        }
        found.push(...(await this.checkUnexplained(tx, tenantIds)));
        found.push(...(await this.checkDailyBalances(tx, tenantIds)));
        return found;
      });
    });

    const result = {
      ok: mismatches.length === 0,
      checkedAt: new Date().toISOString(),
      mismatches,
    };
    if (result.ok) {
      this.logger.log('Ledger reconciliation passed');
    } else {
      this.logger.error(
        { count: mismatches.length, mismatches: mismatches.slice(0, 50) },
        `Ledger reconciliation found ${mismatches.length} mismatch(es)`,
      );
    }
    return result;
  }

  private scheduleNext(): void {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(RUN_AT_UTC_HOUR, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    this.timer = setTimeout(() => {
      this.run()
        .catch((error: unknown) =>
          this.logger.error(error, 'Ledger reconciliation could not run'),
        )
        .finally(() => this.scheduleNext());
    }, next.getTime() - now.getTime());
    this.timer.unref();
  }

  private registeredTypes(): SQL {
    return sql.join(
      [...this.sources.keys()].map((type) => sql`${type}`),
      sql`, `,
    );
  }

  private async checkDocuments(
    tx: Tx,
    source: ReconciliationSource,
    tenantIds?: string[],
  ): Promise<LedgerMismatch[]> {
    const type = source.sourceType;
    return mismatchRows(
      tx,
      sql`
      with expected as (${source.expected}),
      actual as (
        select le.tenant_id, le.trader_id, le.source_id,
               sum(le.debit - le.credit) as net
          from ledger_entries le
         where le.source_type = ${type}
            or (le.source_type = 'reversal' and exists (
                  select 1 from ledger_entries o
                   where o.tenant_id = le.tenant_id
                     and o.source_id = le.source_id
                     and o.source_type = ${type}))
         group by le.tenant_id, le.trader_id, le.source_id
      )
      select 'document' as "check",
             coalesce(e.tenant_id, a.tenant_id) as tenant_id,
             coalesce(e.trader_id, a.trader_id) as trader_id,
             ${type} as source_type,
             coalesce(e.source_id, a.source_id) as source_id,
             null as entry_date,
             coalesce(e.net, 0)::numeric(14,2)::text as expected,
             coalesce(a.net, 0)::numeric(14,2)::text as actual
        from expected e
        full join actual a
          on a.tenant_id = e.tenant_id
         and a.trader_id = e.trader_id
         and a.source_id = e.source_id
       where coalesce(e.net, 0) <> coalesce(a.net, 0)
         and ${inShops(sql`coalesce(e.tenant_id, a.tenant_id)`, tenantIds)}
       limit ${MAX_ROWS}`,
    );
  }

  /** Entries that are not an adjustment, a registered document or its reversal. */
  private async checkUnexplained(
    tx: Tx,
    tenantIds?: string[],
  ): Promise<LedgerMismatch[]> {
    const registered = this.sources.size
      ? sql`le.source_type in (${this.registeredTypes()})`
      : sql`false`;
    const reversalOfRegistered = this.sources.size
      ? sql`exists (
          select 1 from ledger_entries o
           where o.tenant_id = le.tenant_id
             and o.source_id = le.source_id
             and o.source_type in (${this.registeredTypes()}))`
      : sql`false`;
    return mismatchRows(
      tx,
      sql`
      select 'unexplained' as "check", le.tenant_id, le.trader_id,
             le.source_type, le.source_id, null as entry_date,
             '0.00' as expected,
             sum(le.debit - le.credit)::numeric(14,2)::text as actual
        from ledger_entries le
       where le.source_type <> 'adjustment'
         and not ${registered}
         and not (le.source_type = 'reversal' and ${reversalOfRegistered})
         and ${inShops(sql`le.tenant_id`, tenantIds)}
       group by le.tenant_id, le.trader_id, le.source_type, le.source_id
       limit ${MAX_ROWS}`,
    );
  }

  private async checkDailyBalances(
    tx: Tx,
    tenantIds?: string[],
  ): Promise<LedgerMismatch[]> {
    return mismatchRows(
      tx,
      sql`
      with entries as (
        select tenant_id, trader_id, entry_date,
               sum(debit) as debit, sum(credit) as credit
          from ledger_entries
         where ${inShops(sql`tenant_id`, tenantIds)}
         group by tenant_id, trader_id, entry_date
      ),
      snapshots as (
        select * from ledger_daily_balances
         where ${inShops(sql`tenant_id`, tenantIds)}
      )
      select 'daily_balance' as "check",
             coalesce(e.tenant_id, s.tenant_id) as tenant_id,
             coalesce(e.trader_id, s.trader_id) as trader_id,
             null as source_type, null as source_id,
             coalesce(e.entry_date, s.entry_date)::text as entry_date,
             coalesce(e.debit, 0)::numeric(14,2)::text || '/' ||
               coalesce(e.credit, 0)::numeric(14,2)::text as expected,
             coalesce(s.debit, 0)::numeric(14,2)::text || '/' ||
               coalesce(s.credit, 0)::numeric(14,2)::text as actual
        from entries e
        full join snapshots s
          on s.tenant_id = e.tenant_id
         and s.trader_id = e.trader_id
         and s.entry_date = e.entry_date
       where coalesce(e.debit, 0) <> coalesce(s.debit, 0)
          or coalesce(e.credit, 0) <> coalesce(s.credit, 0)
       limit ${MAX_ROWS}`,
    );
  }
}

type Tx = PlatformScope['tx'];

interface Row extends Record<string, unknown> {
  check: LedgerMismatch['check'];
  tenant_id: string;
  trader_id: string;
  source_type: string | null;
  source_id: string | null;
  entry_date: string | null;
  expected: string;
  actual: string;
}

async function mismatchRows(tx: Tx, query: SQL): Promise<LedgerMismatch[]> {
  const { rows } = (await tx.execute(query)) as { rows: Row[] };
  return rows.map(toMismatch);
}

function toMismatch(row: Row): LedgerMismatch {
  return {
    check: row.check,
    tenantId: row.tenant_id,
    traderId: row.trader_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    entryDate: row.entry_date,
    expected: row.expected,
    actual: row.actual,
  };
}

function inShops(column: SQL, tenantIds?: string[]): SQL {
  if (!tenantIds) return sql`true`;
  if (!tenantIds.length) return sql`false`;
  return sql`${column} in (${sql.join(
    tenantIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}
