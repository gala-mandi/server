import Decimal from 'decimal.js';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  CHARGE_BASES,
  CHARGE_TYPES,
  RATE_UNITS,
} from '../../common/charges/calculate-transaction';
import { isCalendarDate } from '../../common/time/karachi-date';
import { docStatus } from '../../database/schema';

export const PURCHASE_STATUSES = docStatus.enumValues;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

/** Most items one parchi may carry. */
export const MAX_ITEMS = 100;

const day = z
  .string()
  .trim()
  .refine(isCalendarDate, 'Enter the date as YYYY-MM-DD');

// Money and weights travel as strings so no float rounding touches them.
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const money = z
  .string()
  .trim()
  .regex(MONEY, 'Enter an amount in rupees (up to 2 decimals)');
const hasDigit = (v: string) => /[1-9]/.test(v);

const weightKg = z
  .string('Enter the weight in kg')
  .trim()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, 'Enter the weight in kg (up to 3 decimals)')
  .refine(hasDigit, 'Enter a weight above 0');

const rate = z
  .string('Enter the rate')
  .trim()
  .regex(MONEY, 'Enter the rate in rupees (up to 2 decimals)')
  .refine(hasDigit, 'Enter a rate above 0');

const percent = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter a percentage (up to 2 decimals)')
  .refine((v) => new Decimal(v).lte(100), 'Enter 100% or less');

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters`)
    .nullish()
    .transform((v) => v || null);

export const purchaseItemInputSchema = z
  .object({
    commodityId: z.uuid('Choose a commodity'),
    bags: z
      .number('Enter the number of bags')
      .int('Enter a whole number of bags')
      .min(0, 'Enter 0 or more bags')
      .max(1_000_000, 'Enter at most 1,000,000 bags')
      .nullish()
      .transform((v) => v ?? null),
    weightKg,
    rate,
    /** What the rate is per; a per-bag rate needs bags. */
    rateUnit: z.enum(RATE_UNITS, 'Choose kg, maund or bag').default('maund'),
  })
  .strict();

/**
 * Charges typed on the parchi, for all its items. Missing = not changed
 * (the commodity's value, else the shop default); `null` on an edit = back
 * to that default.
 */
export const manualChargesSchema = z
  .object({
    commissionPct: percent.nullish(),
    marketFeePct: percent.nullish(),
    labourPerBag: money.nullish(),
  })
  .strict();

const items = z
  .array(purchaseItemInputSchema, 'Add at least one item')
  .min(1, 'Add at least one item')
  .max(MAX_ITEMS, `Use at most ${MAX_ITEMS} items`);

const fields = {
  /** The kissan selling the goods. */
  traderId: z.uuid('Choose a kissan'),
  /** Defaults to today (Asia/Karachi); never in the future. */
  purchaseDate: day,
  items,
  charges: manualChargesSchema,
  /** Paid to the kissan on the same save; at most the net amount. */
  paidAmount: money,
  notes: optionalText(1000),
};

export const createPurchaseSchema = z
  .object({
    ...fields,
    purchaseDate: fields.purchaseDate.optional(),
    charges: fields.charges.default({}),
    paidAmount: fields.paidAmount.default('0'),
  })
  .strict();

/** Any of the fields; `items` replaces all items of the purchase. */
export const updatePurchaseSchema = z.object(fields).partial().strict();

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** 1–64 visible ASCII characters, e.g. a UUID made by the client. */
export const idempotencyKeySchema = z
  .string(`Send an ${IDEMPOTENCY_HEADER} header`)
  .trim()
  .min(1, `Send an ${IDEMPOTENCY_HEADER} header`)
  .max(64, `${IDEMPOTENCY_HEADER} must be at most 64 characters`)
  .regex(
    /^[\x21-\x7e]+$/,
    `${IDEMPOTENCY_HEADER} may only use visible ASCII characters`,
  );

export const PURCHASE_SORTS = [
  'purchaseDate',
  '-purchaseDate',
  'billNo',
  '-billNo',
] as const;

export const listPurchasesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    /** Bill number, or the kissan's name or phone. */
    search: z.string().trim().max(120).optional(),
    from: day.optional(),
    to: day.optional(),
    trader: z.uuid('Choose a kissan').optional(),
    /** Purchases with at least one item of this commodity. */
    commodity: z.uuid('Choose a commodity').optional(),
    status: z.enum(PURCHASE_STATUSES).optional(),
    sort: z.enum(PURCHASE_SORTS).default('-purchaseDate'),
  })
  // YYYY-MM-DD strings sort like dates.
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'The start date must be on or before the end date',
    path: ['from'],
  });

export type PurchaseItemInput = z.infer<typeof purchaseItemInputSchema>;
export type ManualChargesInput = z.infer<typeof manualChargesSchema>;
export type CreatePurchaseInput = z.infer<typeof createPurchaseSchema>;
export type UpdatePurchaseInput = z.infer<typeof updatePurchaseSchema>;
export type ListPurchasesQuery = z.infer<typeof listPurchasesQuerySchema>;

export const purchaseSummarySchema = z.object({
  id: z.uuid(),
  /** e.g. PUR-2026-27-000123; kept when cancelled, never reused. */
  billNo: z.string(),
  purchaseDate: z.iso.date(),
  trader: z.object({ id: z.uuid(), name: z.string() }),
  /** Rupees, e.g. "100000.00" */
  grossAmount: z.string(),
  totalDeductions: z.string(),
  /** What the net was rounded by: net − (gross − deductions), e.g. "-0.46". */
  rounding: z.string(),
  /** Credited to the kissan's khata. */
  netAmount: z.string(),
  /** Paid on the same save (debited back in the khata). */
  paidAmount: z.string(),
  /**
   * Still to pay the kissan on this bill: net − paid on save − payment
   * vouchers against it; "0.00" when cancelled.
   */
  outstanding: z.string(),
  status: z.enum(PURCHASE_STATUSES),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const purchaseItemSchema = z.object({
  id: z.uuid(),
  commodityId: z.uuid(),
  commodityName: z.string(),
  bags: z.number().int().nullable(),
  /** Kg, e.g. "1000.000" */
  weightKg: z.string(),
  /** Rupees per `rateUnit`, as saved. */
  rate: z.string(),
  rateUnit: z.enum(RATE_UNITS),
  amount: z.string(),
});

export const purchaseChargeSchema = z.object({
  id: z.uuid(),
  type: z.enum(CHARGE_TYPES),
  basis: z.enum(CHARGE_BASES),
  /** "2.00" (%), "20.00" (Rs per bag) or "150.00" (Rs), as saved. */
  value: z.string(),
  amount: z.string(),
});

export const purchaseSchema = purchaseSummarySchema.extend({
  items: z.array(purchaseItemSchema),
  charges: z.array(purchaseChargeSchema),
  createdBy: z.uuid().nullable(),
});

export type PurchaseSummary = z.infer<typeof purchaseSummarySchema>;
export type Purchase = z.infer<typeof purchaseSchema>;

export class CreatePurchaseDto extends createZodDto(createPurchaseSchema) {}
export class UpdatePurchaseDto extends createZodDto(updatePurchaseSchema) {}
export class ListPurchasesQueryDto extends createZodDto(
  listPurchasesQuerySchema,
) {}
export class PurchaseDto extends createZodDto(purchaseSchema) {}
export class PurchaseListDto extends createZodDto(
  z.object({
    data: z.array(purchaseSummarySchema),
    meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }),
  }),
) {}
