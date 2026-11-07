/**
 * After a load run: checks the saved purchases of the load-test shops
 * (slug `load-shop-*`) straight in the database.
 *
 * - no bill number twice in a shop
 * - no gaps: each shop's purchase numbers are exactly 1..n, and its
 *   number_sequences row says n + 1 is next (a failed save gave its number back)
 * - every purchase has its khata lines
 *
 * Prints one line per check and exits with 1 when any check fails.
 * Usage: npm run load:verify (reads .env)
 */
import { Pool } from 'pg';

interface Check {
  name: string;
  sql: string;
}

const LOAD_SHOPS = `select id from tenants where slug like 'load-shop-%'`;

/** Each query returns the offending rows; none = pass. */
const CHECKS: Check[] = [
  {
    name: 'duplicate bill numbers per shop',
    sql: `
      select tenant_id, bill_no, count(*) as copies
        from purchases
       where tenant_id in (${LOAD_SHOPS})
       group by tenant_id, bill_no
      having count(*) > 1`,
  },
  {
    name: 'gaps in bill numbers per shop and financial year',
    sql: `
      with numbered as (
        select tenant_id,
               -- PUR-2026-27-000123: prefix, financial year, number
               substring(bill_no from '^[^-]+-(.+)-[0-9]+$') as fy,
               substring(bill_no from '([0-9]+)$')::int as n
          from purchases
         where tenant_id in (${LOAD_SHOPS})
      ), per_year as (
        select tenant_id, fy, count(*) as saved, min(n) as first, max(n) as last
          from numbered group by tenant_id, fy
      )
      select p.tenant_id, p.fy, p.saved, p.first, p.last,
             s.next_number - 1 as sequence_last
        from per_year p
        left join number_sequences s
          on s.tenant_id = p.tenant_id
         and s.doc_type = 'purchase'
         and s.financial_year = p.fy
       where p.first <> 1
          or p.last <> p.saved
          or s.next_number is distinct from p.saved + 1`,
  },
  {
    name: 'purchases without khata lines',
    sql: `
      select p.tenant_id, p.id, p.bill_no
        from purchases p
       where p.tenant_id in (${LOAD_SHOPS})
         and not exists (
           select 1 from ledger_entries l
            where l.tenant_id = p.tenant_id
              and l.source_type = 'purchase'
              and l.source_id = p.id)`,
  },
];

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let failed = false;
  try {
    const {
      rows: [totals],
    } = await pool.query<{ shops: string; purchases: string }>(`
      select (select count(*) from tenants where slug like 'load-shop-%') as shops,
             (select count(*) from purchases where tenant_id in (${LOAD_SHOPS})) as purchases`);
    console.log(
      `Load shops: ${totals.shops}, purchases saved: ${totals.purchases}`,
    );
    for (const check of CHECKS) {
      const { rows } = await pool.query(check.sql);
      failed ||= rows.length > 0;
      console.log(
        `${rows.length ? 'FAIL' : 'PASS'}  ${check.name}: ${rows.length} found`,
      );
      if (rows.length) console.table(rows.slice(0, 20));
    }
  } finally {
    await pool.end();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
