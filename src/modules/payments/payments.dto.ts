import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isCalendarDate } from '../../common/time/karachi-date';
import { docStatus } from '../../database/schema';
import {
  IDEMPOTENCY_HEADER,
  idempotencyKeySchema,
} from '../purchases/purchases.dto';
import { DIRECTIONS } from './payment-allocation';
import { OVERPAYMENT } from './payment-rules';

// One header and one key format for every money document.
export { IDEMPOTENCY_HEADER, idempotencyKeySchema };

export const PAYMENT_STATUSES = docStatus.enumValues;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ['cash', 'bank', 'cheque', 'online'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Most bills one voucher may settle. */
export const MAX_ALLOCATIONS = 100;

/** Longest date range of one cash book. */
export const MAX_CASH_BOOK_DAYS = 366;

const day = z
  .string()
  .trim()
  .refine(isCalendarDate, 'Enter the date as YYYY-MM-DD');

// Money travels as a string so no float rounding touches it.
const money = z
  .string('Enter an amount in rupees')
  .trim()
  .regex(
    /^\d{1,12}(\.\d{1,2})?$/,
    'Enter an amount in rupees (up to 2 decimals)',
  );
const positiveMoney = money.refine(
  (v) => /[1-9]/.test(v),
  'Enter an amount above 0',
);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters`)
    .nullish()
    .transform((v) => v || null);

/**
 * One bill the payment settles: a purchase for money paid, a sale for money
 * received. Leave `amount` out to settle as much of the bill as the payment
 * has left.
 */
export const allocationInputSchema = z
  .object({
    purchaseId: z.uuid('Choose a purchase bill').optional(),
    saleId: z.uuid('Choose a sale bill').optional(),
    amount: positiveMoney.nullish(),
  })
  .strict()
  .refine((a) => (a.purchaseId === undefined) !== (a.saleId === undefined), {
    message: 'Choose one bill: a purchase or a sale',
    path: ['purchaseId'],
  });

export const createPaymentSchema = z
  .object({
    /** paid: to a kissan; received: from a beopari. */
    direction: z.enum(DIRECTIONS, 'Choose paid or received'),
    traderId: z.uuid('Choose a trader'),
    /** Defaults to today (Asia/Karachi); never in the future. */
    paymentDate: day.optional(),
    amount: positiveMoney,
    method: z.enum(PAYMENT_METHODS, 'Choose cash, bank, cheque or online'),
    /** Cheque number, bank or transfer reference. */
    reference: optionalText(80),
    notes: optionalText(1000),
    /** Bills it settles; none = all of it is an advance. */
    allocations: z
      .array(allocationInputSchema)
      .max(MAX_ALLOCATIONS, `Use at most ${MAX_ALLOCATIONS} bills`)
      .default([]),
  })
  .strict();

export const PAYMENT_SORTS = [
  'paymentDate',
  '-paymentDate',
  'voucherNo',
  '-voucherNo',
] as const;

export const listPaymentsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    /** Voucher number, or the trader's name or phone. */
    search: z.string().trim().max(120).optional(),
    from: day.optional(),
    to: day.optional(),
    direction: z.enum(DIRECTIONS).optional(),
    trader: z.uuid('Choose a trader').optional(),
    method: z.enum(PAYMENT_METHODS).optional(),
    status: z.enum(PAYMENT_STATUSES).optional(),
    sort: z.enum(PAYMENT_SORTS).default('-paymentDate'),
  })
  // YYYY-MM-DD strings sort like dates.
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'The start date must be on or before the end date',
    path: ['from'],
  });

/** Both default to today (Asia/Karachi); `from` alone runs to today. */
export const cashBookQuerySchema = z.object({
  from: day.optional(),
  to: day.optional(),
});

export type AllocationInput = z.infer<typeof allocationInputSchema>;
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;
export type CashBookQuery = z.infer<typeof cashBookQuerySchema>;

export const paymentSummarySchema = z.object({
  id: z.uuid(),
  /** PAY-2026-27-000123 (paid) or RCT-2026-27-000123 (received). */
  voucherNo: z.string(),
  direction: z.enum(DIRECTIONS),
  paymentDate: z.iso.date(),
  trader: z.object({ id: z.uuid(), name: z.string() }),
  /** Rupees, e.g. "40000.00"; the whole amount is in the khata. */
  amount: z.string(),
  /** The part settling bills. */
  allocated: z.string(),
  /** The part no bill takes (peshgi). */
  advance: z.string(),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().nullable(),
  /** A cancelled payment's allocations no longer count. */
  status: z.enum(PAYMENT_STATUSES),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const paymentAllocationSchema = z.object({
  id: z.uuid(),
  purchaseId: z.uuid().nullable(),
  saleId: z.uuid().nullable(),
  billNo: z.string(),
  billDate: z.iso.date(),
  amount: z.string(),
});

export const paymentSchema = paymentSummarySchema.extend({
  allocations: z.array(paymentAllocationSchema),
  createdBy: z.uuid().nullable(),
});

/** Saved, but the user should know (the shop's setting is "advance"). */
export const paymentWarningSchema = z.object({
  code: z.literal(OVERPAYMENT),
  message: z.string(),
  /** What the khata owed before this payment, e.g. "100000.00". */
  owed: z.string(),
  /** The amount above it, now an advance, e.g. "20000.00". */
  excess: z.string(),
});

/** What a create returns: the payment and any warnings of that save. */
export const savedPaymentSchema = paymentSchema.extend({
  warnings: z.array(paymentWarningSchema),
});

export const cashBookSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  /** Cash in hand at the start of `from`: every cash voucher before it. */
  openingCash: z.string(),
  /** Days with cash vouchers only, oldest first. */
  days: z.array(
    z.object({
      date: z.iso.date(),
      /** Cash received from beoparis. */
      cashIn: z.string(),
      /** Cash paid to kissans. */
      cashOut: z.string(),
      closingCash: z.string(),
    }),
  ),
  totals: z.object({ cashIn: z.string(), cashOut: z.string() }),
  closingCash: z.string(),
});

export type PaymentSummary = z.infer<typeof paymentSummarySchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type PaymentWarning = z.infer<typeof paymentWarningSchema>;
export type SavedPayment = z.infer<typeof savedPaymentSchema>;

export class CreatePaymentDto extends createZodDto(createPaymentSchema) {}
export class ListPaymentsQueryDto extends createZodDto(
  listPaymentsQuerySchema,
) {}
export class CashBookQueryDto extends createZodDto(cashBookQuerySchema) {}
export class PaymentDto extends createZodDto(paymentSchema) {}
export class SavedPaymentDto extends createZodDto(savedPaymentSchema) {}
export class CashBookDto extends createZodDto(cashBookSchema) {}
export class PaymentListDto extends createZodDto(
  z.object({
    data: z.array(paymentSummarySchema),
    meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }),
  }),
) {}
