import { sql } from 'drizzle-orm';
import { numberSequences, tenantSettings } from '../src/database/schema';
import type { TenantScope } from '../src/database/tenant-database';
import type { DocType } from '../src/modules/numbering/bill-number';
import { nextNumber } from '../src/modules/numbering/next-number';
import { Fixtures } from './support/fixtures';

// Mid-year dates in the default (1 July) financial year 2026-27.
const IN_2026_27 = new Date('2026-11-06T07:00:00Z');

/** Bill numbering on a real Postgres, inside RLS-scoped transactions. */
describe('Bill (parchi) numbering (integration)', () => {
  let fx: Fixtures;

  /** The same steps TenantDatabase runs for a request of shop `tenantId`. */
  function inShop<R>(
    tenantId: string,
    fn: (scope: Pick<TenantScope, 'tx' | 'tenantId'>) => Promise<R>,
  ): Promise<R> {
    return fx.db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_tenant`);
      await tx.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true)`,
      );
      return fn({ tx, tenantId });
    });
  }

  function take(
    tenantId: string,
    docType: DocType = 'purchase',
    at = IN_2026_27,
  ) {
    return inShop(tenantId, (scope) => nextNumber(scope, docType, at));
  }

  beforeAll(() => {
    fx = new Fixtures();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('gives shop A and shop B their own series, both starting at 1', async () => {
    const shopA = await fx.tenant();
    const shopB = await fx.tenant();

    expect(await take(shopA)).toEqual({
      number: 1,
      financialYear: '2026-27',
      billNo: 'PUR-2026-27-000001',
    });
    expect((await take(shopA)).number).toBe(2);
    expect((await take(shopB)).number).toBe(1);
    expect((await take(shopA)).number).toBe(3);
  });

  it('keeps a separate series per document type', async () => {
    const shop = await fx.tenant();

    expect((await take(shop, 'purchase')).billNo).toBe('PUR-2026-27-000001');
    expect((await take(shop, 'sale')).billNo).toBe('SAL-2026-27-000001');
    expect((await take(shop, 'payment')).billNo).toBe('PAY-2026-27-000001');
    expect((await take(shop, 'receipt')).billNo).toBe('RCT-2026-27-000001');
    expect((await take(shop, 'purchase')).billNo).toBe('PUR-2026-27-000002');
  });

  it('gives 20 parallel saves 20 unique, consecutive numbers', async () => {
    const shop = await fx.tenant();

    const numbers = await Promise.all(
      Array.from({ length: 20 }, () =>
        inShop(shop, async (scope) => {
          const bill = await nextNumber(scope, 'purchase', IN_2026_27);
          // Hold the lock a moment, like a document save does, so the
          // other transactions really wait on it.
          await scope.tx.execute(sql`select pg_sleep(0.02)`);
          return bill.number;
        }),
      ),
    );

    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it('does not consume a number when the transaction rolls back', async () => {
    const shop = await fx.tenant();
    await take(shop);

    await expect(
      inShop(shop, async (scope) => {
        expect((await nextNumber(scope, 'purchase', IN_2026_27)).number).toBe(
          2,
        );
        throw new Error('save failed');
      }),
    ).rejects.toThrow('save failed');

    expect((await take(shop)).number).toBe(2);
  });

  it('restarts the series at 1 in a new financial year', async () => {
    const shop = await fx.tenant();
    const lastDay = new Date('2027-06-30T12:00:00Z');
    const firstDay = new Date('2027-07-01T12:00:00Z');

    await take(shop, 'sale', lastDay);
    expect((await take(shop, 'sale', lastDay)).billNo).toBe(
      'SAL-2026-27-000002',
    );
    expect(await take(shop, 'sale', firstDay)).toEqual({
      number: 1,
      financialYear: '2027-28',
      billNo: 'SAL-2027-28-000001',
    });
    // Late entries for the old year continue the old series.
    expect((await take(shop, 'sale', lastDay)).number).toBe(3);
  });

  it("uses the shop's bill prefix and financial year start", async () => {
    const shop = await fx.tenant();
    await fx.db.insert(tenantSettings).values({
      tenantId: shop,
      billPrefix: 'AK',
      financialYearStart: '2020-01-01',
    });

    expect(await take(shop, 'purchase')).toEqual({
      number: 1,
      financialYear: '2026',
      billNo: 'AK-2026-000001',
    });
  });

  it("never shows or moves another shop's sequence", async () => {
    const shopA = await fx.tenant();
    const shopB = await fx.tenant();
    await take(shopA);
    await take(shopB);

    const visible = await inShop(shopA, ({ tx }) =>
      tx.select().from(numberSequences),
    );
    expect(visible.map((row) => row.tenantId)).toEqual([shopA]);

    // A forged tenant id inside shop A's transaction is refused by RLS.
    await expect(
      inShop(shopA, (scope) =>
        nextNumber({ ...scope, tenantId: shopB }, 'purchase', IN_2026_27),
      ),
    ).rejects.toThrow();
    expect((await take(shopB)).number).toBe(2);
  });
});
