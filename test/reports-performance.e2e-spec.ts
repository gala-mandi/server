import { INestApplication } from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { tenantSettings } from '../src/database/schema';
import { OTP_SENDER } from '../src/modules/auth/otp/otp-sender';
import type {
  CommissionReport,
  PurchasesReport,
} from '../src/modules/reports/reports.dto';
import { createTestApp } from './create-app';
import { Fixtures, PASSWORD } from './support/fixtures';

/**
 * "1 year of data for a busy shop under 2 s." One financial year
 * (2025-07-01 … 2026-06-30, 365 days) of a shop doing 100 purchases and 100
 * sales a day (2 commodity lines and 3 charge lines each) and 50 cash
 * vouchers a day, with 300 kissans, 200 beoparis and their khata. Every
 * 50th bill is cancelled. Generated in SQL, in a few statements, in one
 * transaction. `REPORTS_PERF_BILLS_PER_DAY` sets a bigger shop (e.g. 200).
 */
const FROM = '2025-07-01';
const TO = '2026-06-30';
const DAYS = 365;
const BILLS_PER_DAY = Number(process.env.REPORTS_PERF_BILLS_PER_DAY ?? 100);
const VOUCHERS_PER_DAY = BILLS_PER_DAY / 2;
const LIMIT_MS = 2000;

const BILLS = DAYS * BILLS_PER_DAY;
const CANCELLED = BILLS / 50;

describe('Reports performance (e2e)', () => {
  let app: INestApplication<App>;
  let fx: Fixtures;
  let shop: string;
  let token: string;
  const timings: Record<string, number> = {};

  const http = () => request(app.getHttpServer());

  function resetThrottle(): void {
    const storage = app.get<ThrottlerStorageService>(getStorageToken(), {
      strict: false,
    });
    storage.storage.clear();
    (
      Reflect.get(storage, 'hitExpirations') as Map<string, unknown> | undefined
    )?.clear();
  }

  /**
   * Seeds the year as the database owner, bypassing the API. With a
   * superuser (the dev and CI Postgres) the rows go in with foreign-key and
   * ledger triggers off, three times faster; the data is consistent by
   * construction and the daily balances are summed from the entries.
   */
  async function seed(tenantId: string, ownerId: string): Promise<void> {
    const client = await fx.pool.connect();
    try {
      await writeYear(client, tenantId, ownerId);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    // Fresh statistics, as autovacuum would have after a year.
    await fx.pool
      .query(`analyze traders, commodities, purchases, purchase_items,
      purchase_charges, sales, sale_items, sale_charges, payments,
      ledger_entries, ledger_daily_balances`);
  }

  async function writeYear(
    client: PoolClient,
    tenantId: string,
    ownerId: string,
  ): Promise<void> {
    const q = (text: string) => client.query(text, [tenantId]);
    await client.query('begin');
    const { rows } = await client.query<{ rolsuper: boolean }>(
      'select rolsuper from pg_roles where rolname = current_user',
    );
    const fast = rows[0]?.rolsuper === true;
    if (fast)
      await client.query('set local session_replication_role = replica');
    await q(`
      insert into traders (tenant_id, type, name)
      select $1, (case when g <= 300 then 'kissan' else 'beopari' end)::trader_type,
             'Perf trader ' || lpad(g::text, 3, '0')
        from generate_series(1, 500) g`);
    await q(`
      insert into commodities (tenant_id, name)
      select $1, 'Perf commodity ' || g from generate_series(1, 5) g`);

    // Bills: n = day * 200 + j. The amounts are fixed per book, so the
    // expected totals are simple to state.
    for (const book of [
      {
        table: 'purchases',
        date: 'purchase_date',
        trader: 'trader_id',
        type: 'kissan',
        traders: 300,
        prefix: 'PUR',
        charges: 'total_deductions',
        net: '96900',
        deductions: '3100',
        gross: '100000',
      },
      {
        table: 'sales',
        date: 'sale_date',
        trader: 'buyer_id',
        type: 'beopari',
        traders: 200,
        prefix: 'SAL',
        charges: 'total_charges',
        net: '105675',
        deductions: '3175',
        gross: '102500',
      },
    ]) {
      await q(`
        with t as (
          select id, (row_number() over (order by name) - 1)::int as i
            from traders where tenant_id = $1 and type = '${book.type}'),
        bill as (
          select d * ${BILLS_PER_DAY} + j as n, d from generate_series(0, ${DAYS - 1}) d,
                 generate_series(0, ${BILLS_PER_DAY - 1}) j)
        insert into ${book.table} (tenant_id, bill_no, ${book.trader}, ${book.date},
               gross_amount, ${book.charges}, net_amount, status, created_by)
        select $1, '${book.prefix}-' || lpad(bill.n::text, 6, '0'), t.id,
               date '${FROM}' + bill.d, ${book.gross}, ${book.deductions}, ${book.net},
               (case when bill.n % 50 = 0 then 'cancelled' else 'posted' end)::doc_status,
               '${ownerId}'
          from bill join t on t.i = bill.n % ${book.traders}`);
    }

    // Two commodity lines per bill: 500 kg, 5 bags each.
    for (const [items, bill, bills, rate, amount] of [
      ['purchase_items', 'purchase_id', 'purchases', '4000', '50000'],
      ['sale_items', 'sale_id', 'sales', '4100', '51250'],
    ]) {
      await q(`
        with c as (
          select id, (row_number() over (order by name) - 1)::int as i
            from commodities where tenant_id = $1)
        insert into ${items} (tenant_id, ${bill}, commodity_id, bags, weight_kg, rate, rate_unit, amount)
        select $1, b.id, c.id, 5, 500, ${rate}, 'maund', ${amount}
          from ${bills} b cross join generate_series(0, 1) g
          join c on c.i = (substr(b.bill_no, 5)::int + g) % 5
         where b.tenant_id = $1`);
    }

    // Commission 2%, market fee 1%, labour Rs 10 a bag.
    for (const [charges, bill, bills, commission, fee] of [
      ['purchase_charges', 'purchase_id', 'purchases', '2000', '1000'],
      ['sale_charges', 'sale_id', 'sales', '2050', '1025'],
    ]) {
      await q(`
        insert into ${charges} (tenant_id, ${bill}, type, basis, value, amount)
        select $1, b.id, c.type, c.basis, c.value, c.amount
          from ${bills} b cross join (values
            ('commission', 'percent', 2, ${commission}),
            ('market_fee', 'percent', 1, ${fee}),
            ('labour', 'per_bag', 10, 100)) c(type, basis, value, amount)
         where b.tenant_id = $1`);
    }

    // 100 cash vouchers a day: 50 paid (Rs 20,000) and 50 received (Rs 30,000).
    await q(`
      with k as (
        select id, type, (row_number() over (partition by type order by name) - 1)::int as i
          from traders where tenant_id = $1),
      v as (
        select d * ${VOUCHERS_PER_DAY} + j as n, d from generate_series(0, ${DAYS - 1}) d,
               generate_series(0, ${VOUCHERS_PER_DAY - 1}) j)
      insert into payments (tenant_id, voucher_no, direction, trader_id, payment_date, amount, method)
      select $1, (case when v.n % 2 = 0 then 'PAY-' else 'RCT-' end) || lpad(v.n::text, 6, '0'),
             case when v.n % 2 = 0 then 'paid' else 'received' end, k.id,
             date '${FROM}' + v.d, case when v.n % 2 = 0 then 20000 else 30000 end, 'cash'
        from v join k on k.type = (case when v.n % 2 = 0 then 'kissan' else 'beopari' end)::trader_type
                     and k.i = v.n % (case when v.n % 2 = 0 then 300 else 200 end)`);

    // The khata, as the services would have written it (the trigger keeps
    // ledger_daily_balances). A cancelled bill has its entry and a reversal.
    await q(`
      insert into ledger_entries (tenant_id, trader_id, entry_date, source_type, source_id, debit, credit)
      select tenant_id, trader_id, purchase_date, 'purchase', id, 0, net_amount
        from purchases where tenant_id = $1
      union all
      select tenant_id, trader_id, purchase_date, 'reversal', id, net_amount, 0
        from purchases where tenant_id = $1 and status = 'cancelled'
      union all
      select tenant_id, buyer_id, sale_date, 'sale', id, net_amount, 0
        from sales where tenant_id = $1
      union all
      select tenant_id, buyer_id, sale_date, 'reversal', id, 0, net_amount
        from sales where tenant_id = $1 and status = 'cancelled'
      union all
      select tenant_id, trader_id, payment_date,
             case when direction = 'paid' then 'payment' else 'receipt' end, id,
             case when direction = 'paid' then amount else 0 end,
             case when direction = 'received' then amount else 0 end
        from payments where tenant_id = $1`);
    if (fast) {
      // What the ledger trigger would have written.
      await q(`
        insert into ledger_daily_balances (tenant_id, trader_id, entry_date, debit, credit)
        select tenant_id, trader_id, entry_date, sum(debit), sum(credit)
          from ledger_entries where tenant_id = $1
         group by tenant_id, trader_id, entry_date`);
    }
    await client.query('commit');
  }

  /** The best of two runs (the first warms the connection pool and caches). */
  async function timed(path: string, query: Record<string, unknown>) {
    let best = Infinity;
    let body: unknown;
    for (let run = 0; run < 2; run += 1) {
      resetThrottle();
      const started = process.hrtime.bigint();
      const res = await http()
        .get(`/reports/${path}`)
        .set('Authorization', `Bearer ${token}`)
        .query(query)
        .expect(200);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      best = Math.min(best, ms);
      body = res.body;
    }
    const name = `${path} ${new URLSearchParams(query as Record<string, string>).toString()}`;
    timings[name] = Math.round(best);
    return { ms: best, body };
  }

  beforeAll(async () => {
    fx = new Fixtures();
    app = await createTestApp({
      override: (builder) =>
        builder
          .overrideProvider(OTP_SENDER)
          .useValue({ send: () => Promise.resolve() }),
    });
    shop = await fx.tenant();
    await fx.db.insert(tenantSettings).values({ tenantId: shop });
    const owner = await fx.user('owner', shop);
    const started = Date.now();
    await seed(shop, owner.id);
    timings['(seeding)'] = Date.now() - started;
    resetThrottle();
    const res = await http()
      .post('/auth/login')
      .send({ identifier: owner.phone, password: PASSWORD })
      .expect(200);
    token = res.body.accessToken as string;
  }, 300_000);

  /**
   * Deletes the year table by table, children first, vacuuming each one
   * straight away: otherwise every row deleted from a parent makes Postgres
   * check its foreign keys against hundreds of thousands of dead child rows.
   * `fx.cleanup()` then removes the rest of the shop.
   */
  async function purge(tenantId: string): Promise<void> {
    for (const table of [
      'payment_allocations',
      'purchase_charges',
      'sale_charges',
      'sale_items',
      'purchase_items',
      'payments',
      'sales',
      'purchases',
      'ledger_entries',
      'ledger_daily_balances',
    ]) {
      await fx.pool.query(`delete from ${table} where tenant_id = $1`, [
        tenantId,
      ]);
      await fx.pool.query(`vacuum ${table}`);
    }
  }

  afterAll(async () => {
    // Printed for the PR: the time of each report on the year.
    console.log('Reports on a busy year (ms):', timings);
    await app.close();
    const started = Date.now();
    if (shop) await purge(shop);
    console.log('Clean-up (ms):', Date.now() - started);
    await fx.cleanup();
  }, 300_000);

  const year = { from: FROM, to: TO };
  const posted = BILLS - CANCELLED;

  it.each(['day', 'commodity', 'trader'])(
    'purchases of the year by %s',
    async (groupBy) => {
      const { ms, body } = await timed('purchases', { ...year, groupBy });
      const report = body as PurchasesReport;
      expect(report.totals).toEqual({
        bills: posted,
        bags: posted * 10,
        weightKg: `${posted * 1000}.000`,
        grossAmount: `${posted * 100000}.00`,
        totalDeductions: `${posted * 3100}.00`,
        netAmount: `${posted * 96900}.00`,
      });
      expect(ms).toBeLessThan(LIMIT_MS);
    },
  );

  it.each(['day', 'commodity', 'trader'])(
    'sales of the year by %s',
    async (groupBy) => {
      const { ms } = await timed('sales', { ...year, groupBy });
      expect(ms).toBeLessThan(LIMIT_MS);
    },
  );

  it('purchases of the year for one commodity', async () => {
    const { ms } = await timed('purchases', {
      ...year,
      groupBy: 'trader',
      commodity: (
        await fx.pool.query<{ id: string }>(
          `select id from commodities where tenant_id = $1 order by name limit 1`,
          [shop],
        )
      ).rows[0].id,
    });
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it('commission of the year', async () => {
    const { ms, body } = await timed('commission', year);
    const report = body as CommissionReport;
    expect(report.days).toHaveLength(DAYS);
    expect(report.totals).toEqual({
      purchases: `${posted * 2000}.00`,
      sales: `${posted * 2050}.00`,
      total: `${posted * 4050}.00`,
    });
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it('cash book of the year', async () => {
    const { ms } = await timed('cash-book', year);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it('outstanding at the end of the year and now', async () => {
    expect((await timed('outstanding', { asOf: TO })).ms).toBeLessThan(
      LIMIT_MS,
    );
    expect((await timed('outstanding', {})).ms).toBeLessThan(LIMIT_MS);
  });

  it('daily summary of the last day', async () => {
    const { ms } = await timed('daily-summary', { date: TO });
    expect(ms).toBeLessThan(LIMIT_MS);
  });
});
