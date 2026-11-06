import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  CHARGE_BASES,
  CHARGE_TYPES,
  RATE_UNITS,
} from '../../common/charges/calculate-transaction';
import { isCalendarDate } from '../../common/time/karachi-date';
import { docStatus } from '../../database/schema';
import {
  IDEMPOTENCY_HEADER,
  idempotencyKeySchema,
  MAX_ITEMS,
  manualChargesSchema,
  purchaseItemInputSchema,
} from '../purchases/purchases.dto';
import { CREDIT_LIMIT_EXCEEDED } from './sale-rules';

// One header and one key format for every parchi.
export { IDEMPOTENCY_HEADER, idempotencyKeySchema, MAX_ITEMS };

export const SALE_STATUSES = docStatus.enumValues;
export type SaleStatus = (typeof SALE_STATUSES)[number];

const day = z
  .string()
  .trim()
  .refine(isCalendarDate, 'Enter the date as YYYY-MM-DD');

// Money travels as a string so no float rounding touches it.
const money = z
  .string()
  .trim()
  .regex(
    /^\d{1,12}(\.\d{1,2})?$/,
    'Enter an amount in rupees (up to 2 decimals)',
  );

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters`)
    .nullish()
    .transform((v) => v || null);

/** A purchase line plus, optionally, the kissan's lot it is sold from. */
export const saleItemInputSchema = purchaseItemInputSchema
  .extend({
    /** A `purchase_items` id of this shop (commission-agent flow). */
    purchaseItemId: z
      .uuid('Choose a lot')
      .nullish()
      .transform((v) => v ?? null),
  })
  .strict();

const items = z
  .array(saleItemInputSchema, 'Add at least one item')
  .min(1, 'Add at least one item')
  .max(MAX_ITEMS, `Use at most ${MAX_ITEMS} items`);

const fields = {
  /** The beopari buying the goods. */
  buyerId: z.uuid('Choose a beopari'),
  /** Defaults to today (Asia/Karachi); never in the future. */
  saleDate: day,
  items,
  charges: manualChargesSchema,
  /** Received from the beopari on the same save; at most the net amount. */
  receivedAmount: money,
  notes: optionalText(1000),
};

export const createSaleSchema = z
  .object({
    ...fields,
    saleDate: fields.saleDate.optional(),
    charges: fields.charges.default({}),
    receivedAmount: fields.receivedAmount.default('0'),
  })
  .strict();

/** Any of the fields; `items` replaces all items of the sale. */
export const updateSaleSchema = z.object(fields).partial().strict();

export const SALE_SORTS = [
  'saleDate',
  '-saleDate',
  'billNo',
  '-billNo',
] as const;

export const listSalesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    /** Bill number, or the beopari's name or phone. */
    search: z.string().trim().max(120).optional(),
    from: day.optional(),
    to: day.optional(),
    buyer: z.uuid('Choose a beopari').optional(),
    /** Sales with at least one item of this commodity. */
    commodity: z.uuid('Choose a commodity').optional(),
    status: z.enum(SALE_STATUSES).optional(),
    sort: z.enum(SALE_SORTS).default('-saleDate'),
  })
  // YYYY-MM-DD strings sort like dates.
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'The start date must be on or before the end date',
    path: ['from'],
  });

export type SaleItemInput = z.infer<typeof saleItemInputSchema>;
export type CreateSaleInput = z.infer<typeof createSaleSchema>;
export type UpdateSaleInput = z.infer<typeof updateSaleSchema>;
export type ListSalesQuery = z.infer<typeof listSalesQuerySchema>;

export const saleSummarySchema = z.object({
  id: z.uuid(),
  /** e.g. SAL-2026-27-000123; kept when cancelled, never reused. */
  billNo: z.string(),
  saleDate: z.iso.date(),
  buyer: z.object({ id: z.uuid(), name: z.string() }),
  /** Rupees, e.g. "100000.00" */
  grossAmount: z.string(),
  /** Added to the gross on a sale. */
  totalCharges: z.string(),
  /** What the net was rounded by: net − (gross + charges), e.g. "0.46". */
  rounding: z.string(),
  /** Debited to the beopari's khata (the receivable). */
  netAmount: z.string(),
  /** Received on the same save (credited back in the khata). */
  receivedAmount: z.string(),
  /**
   * Still to receive from the beopari on this bill: net − received on save
   * − receipt vouchers against it; "0.00" when cancelled.
   */
  outstanding: z.string(),
  status: z.enum(SALE_STATUSES),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const saleItemSchema = z.object({
  id: z.uuid(),
  commodityId: z.uuid(),
  commodityName: z.string(),
  /** The kissan's lot this was sold from, if linked. */
  purchaseItemId: z.uuid().nullable(),
  bags: z.number().int().nullable(),
  /** Kg, e.g. "1000.000" */
  weightKg: z.string(),
  /** Rupees per `rateUnit`, as saved. */
  rate: z.string(),
  rateUnit: z.enum(RATE_UNITS),
  amount: z.string(),
});

export const saleChargeSchema = z.object({
  id: z.uuid(),
  type: z.enum(CHARGE_TYPES),
  basis: z.enum(CHARGE_BASES),
  /** "2.00" (%), "20.00" (Rs per bag) or "150.00" (Rs), as saved. */
  value: z.string(),
  amount: z.string(),
});

export const saleSchema = saleSummarySchema.extend({
  items: z.array(saleItemSchema),
  charges: z.array(saleChargeSchema),
  createdBy: z.uuid().nullable(),
});

/** Saved, but the user should know (the shop's setting is "warn"). */
export const saleWarningSchema = z.object({
  code: z.literal(CREDIT_LIMIT_EXCEEDED),
  message: z.string(),
  /** The buyer's balance after this save, e.g. "120000.00". */
  balance: z.string(),
  creditLimit: z.string(),
});

/** What a create or edit returns: the sale and any warnings of that save. */
export const savedSaleSchema = saleSchema.extend({
  warnings: z.array(saleWarningSchema),
});

export type SaleSummary = z.infer<typeof saleSummarySchema>;
export type Sale = z.infer<typeof saleSchema>;
export type SaleWarning = z.infer<typeof saleWarningSchema>;
export type SavedSale = z.infer<typeof savedSaleSchema>;

export class CreateSaleDto extends createZodDto(createSaleSchema) {}
export class UpdateSaleDto extends createZodDto(updateSaleSchema) {}
export class ListSalesQueryDto extends createZodDto(listSalesQuerySchema) {}
export class SaleDto extends createZodDto(saleSchema) {}
export class SavedSaleDto extends createZodDto(savedSaleSchema) {}
export class SaleListDto extends createZodDto(
  z.object({
    data: z.array(saleSummarySchema),
    meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }),
  }),
) {}
