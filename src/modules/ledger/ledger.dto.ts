import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { traderType } from '../../database/schema';

export const SOURCE_TYPES = [
  'opening',
  'purchase',
  'sale',
  'payment',
  'receipt',
  'adjustment',
  'reversal',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

const day = z.iso.date('Enter the date as YYYY-MM-DD');

// Money travels as a string so no float rounding touches it.
const money = z
  .string()
  .trim()
  .regex(
    /^\d{1,12}(\.\d{1,2})?$/,
    'Enter an amount in rupees (up to 2 decimals)',
  )
  .refine((v) => /[1-9]/.test(v), 'Enter an amount above 0');

export const statementQuerySchema = z
  .object({
    from: day.optional(),
    to: day.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  // YYYY-MM-DD strings sort like dates.
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'The start date must be on or before the end date',
    path: ['from'],
  });

export const balancesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  type: z.enum(traderType.enumValues).optional(),
  sort: z.enum(['name', '-name', 'balance', '-balance']).default('name'),
});

export const adjustmentSchema = z
  .object({
    traderId: z.uuid('Choose a trader'),
    /** Debit raises what the trader owes the shop; credit lowers it. */
    side: z.enum(['debit', 'credit'], 'Choose debit or credit'),
    amount: money,
    reason: z
      .string('Enter the reason for this adjustment')
      .trim()
      .min(3, 'Enter the reason for this adjustment')
      .max(500, 'Use at most 500 characters'),
    /** Defaults to today (shop time); never in the future. */
    entryDate: day.optional(),
  })
  .strict();

export type StatementQuery = z.infer<typeof statementQuerySchema>;
export type BalancesQuery = z.infer<typeof balancesQuerySchema>;
export type AdjustmentInput = z.infer<typeof adjustmentSchema>;

export const ledgerEntrySchema = z.object({
  id: z.number().int(),
  traderId: z.uuid(),
  entryDate: z.iso.date(),
  sourceType: z.enum(SOURCE_TYPES),
  /** The purchase / sale / payment (or trader, for opening) behind it. */
  sourceId: z.uuid().nullable(),
  /** Rupees, e.g. "100000.00" */
  debit: z.string(),
  credit: z.string(),
  narration: z.string().nullable(),
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

export const statementSchema = z.object({
  trader: z.object({
    id: z.uuid(),
    type: z.enum(traderType.enumValues),
    name: z.string(),
  }),
  from: z.iso.date().nullable(),
  to: z.iso.date().nullable(),
  /**
   * Balances are debit minus credit: positive = the trader owes the shop,
   * negative = the shop owes the trader. `openingBalance` is the balance
   * before `from`; `closingBalance` the balance at the end of `to`.
   */
  openingBalance: z.string(),
  closingBalance: z.string(),
  /** The page's entries, each with the running balance after it. */
  data: z.array(ledgerEntrySchema.extend({ balance: z.string() })),
  meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }),
});

export const traderBalanceSchema = z.object({
  traderId: z.uuid(),
  type: z.enum(traderType.enumValues),
  name: z.string(),
  phone: z.string().nullable(),
  /** Debit minus credit, e.g. "-60000.00". */
  balance: z.string(),
  /** What the trader owes the shop ("0.00" when nothing). */
  receivable: z.string(),
  /** What the shop owes the trader ("0.00" when nothing). */
  payable: z.string(),
});

export const balancesSchema = z.object({
  data: z.array(traderBalanceSchema),
  /** All traders matching the filters, not only this page. */
  totals: z.object({ receivable: z.string(), payable: z.string() }),
  meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }),
});

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export type Statement = z.infer<typeof statementSchema>;
export type TraderBalance = z.infer<typeof traderBalanceSchema>;
export type Balances = z.infer<typeof balancesSchema>;

export class StatementQueryDto extends createZodDto(statementQuerySchema) {}
export class BalancesQueryDto extends createZodDto(balancesQuerySchema) {}
export class AdjustmentDto extends createZodDto(adjustmentSchema) {}
export class LedgerEntryDto extends createZodDto(ledgerEntrySchema) {}
export class StatementDto extends createZodDto(statementSchema) {}
export class BalancesDto extends createZodDto(balancesSchema) {}
