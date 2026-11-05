import { eq, sql } from 'drizzle-orm';
import { numberSequences, tenantSettings } from '../../database/schema';
import type { TenantScope } from '../../database/tenant-database';
import {
  DEFAULT_PREFIXES,
  type DocType,
  financialYear,
  formatBillNumber,
  shopDate,
} from './bill-number';

export interface BillNumber {
  /** 1, 2, 3, … within the shop, document type and financial year. */
  number: number;
  /** e.g. `2026-27` */
  financialYear: string;
  /** Printed on the parchi, e.g. `PUR-2026-27-000123`. */
  billNo: string;
}

/**
 * Takes the next bill number for a document. Call it inside the document's
 * own transaction (`TenantDatabase.transaction`): the sequence row stays
 * locked until that transaction ends, so parallel saves wait for each other,
 * and a rollback gives the number back. A saved document keeps its number
 * even when it is cancelled later; numbers are never handed out twice.
 *
 * @param at when the document is saved; decides the financial year
 */
export async function nextNumber(
  { tx, tenantId }: Pick<TenantScope, 'tx' | 'tenantId'>,
  docType: DocType,
  at: Date = new Date(),
): Promise<BillNumber> {
  const [settings] = await tx
    .select({
      billPrefix: tenantSettings.billPrefix,
      financialYearStart: tenantSettings.financialYearStart,
    })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenantId))
    .limit(1);
  const year = financialYear(
    shopDate(at),
    settings?.financialYearStart ?? null,
  );

  // The first number of a year creates the row; every later one locks the
  // existing row and moves it on (the same lock as SELECT … FOR UPDATE).
  const [row] = await tx
    .insert(numberSequences)
    .values({
      tenantId,
      docType,
      financialYear: year,
      prefix: settings?.billPrefix?.trim() || DEFAULT_PREFIXES[docType],
      nextNumber: 2,
    })
    .onConflictDoUpdate({
      target: [
        numberSequences.tenantId,
        numberSequences.docType,
        numberSequences.financialYear,
      ],
      set: { nextNumber: sql`${numberSequences.nextNumber} + 1` },
    })
    .returning({
      nextNumber: numberSequences.nextNumber,
      prefix: numberSequences.prefix,
    });

  const number = row.nextNumber - 1;
  return {
    number,
    financialYear: year,
    billNo: formatBillNumber(
      row.prefix ?? DEFAULT_PREFIXES[docType],
      year,
      number,
    ),
  };
}
