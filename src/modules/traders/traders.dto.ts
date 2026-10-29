import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { traderType } from '../../database/schema';

export const TRADER_TYPES = traderType.enumValues;
export const BALANCE_TYPES = ['debit', 'credit'] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters`)
    .nullish()
    .transform((v) => v || null);

// Money travels as a string so no float rounding touches it.
const money = z
  .string()
  .trim()
  .regex(
    /^\d{1,12}(\.\d{1,2})?$/,
    'Enter an amount in rupees (up to 2 decimals)',
  );

/** Digits only, Pakistan mobile +92 3xx… → 03xx…; other numbers kept as digits. */
export function normalizeTraderPhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('92') && digits.length === 12)
    return `0${digits.slice(2)}`;
  return digits;
}

const phone = z
  .string()
  .trim()
  .nullish()
  .transform((v) => v || null)
  .refine(
    // At least 7 digits: "+------" would otherwise be stored as "".
    (v) =>
      v === null ||
      (/^[+\d][\d\s-]{6,19}$/.test(v) && v.replace(/\D/g, '').length >= 7),
    'Enter a valid phone number',
  )
  .transform((v) => (v === null ? null : normalizeTraderPhone(v)));

/** 13 digits, stored as 12345-1234567-1. */
export function normalizeCnic(input: string): string {
  const d = input.replace(/\D/g, '');
  return `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;
}

const cnic = z
  .string()
  .trim()
  .nullish()
  .transform((v) => v || null)
  .refine(
    (v) => v === null || /^\d{5}-?\d{7}-?\d$/.test(v),
    'Enter the CNIC as 12345-1234567-1',
  )
  .transform((v) => (v === null ? null : normalizeCnic(v)));

const fields = {
  type: z.enum(TRADER_TYPES, 'Choose kissan, beopari or arhti'),
  name: z
    .string()
    .trim()
    .min(2, 'Enter the name')
    .max(120, 'Use at most 120 characters'),
  fatherName: optionalText(120),
  phone,
  cnic,
  village: optionalText(80),
  address: optionalText(500),
  openingBalance: money,
  openingBalanceType: z.enum(BALANCE_TYPES, 'Choose debit or credit'),
  creditLimit: money.nullish().transform((v) => v ?? null),
  isActive: z.boolean(),
  notes: optionalText(1000),
};

export const createTraderSchema = z
  .object({
    ...fields,
    openingBalance: fields.openingBalance.default('0'),
    openingBalanceType: fields.openingBalanceType.default('debit'),
    creditLimit: fields.creditLimit.default(null),
    isActive: fields.isActive.default(true),
  })
  .strict();

export const updateTraderSchema = z.object(fields).partial().strict();

export const listTradersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  type: z.enum(TRADER_TYPES).optional(),
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  sort: z.enum(['name', '-name', 'createdAt', '-createdAt']).default('name'),
});

export const lookupTradersQuerySchema = z.object({
  q: z.string().trim().max(120).default(''),
  type: z.enum(TRADER_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type CreateTraderInput = z.infer<typeof createTraderSchema>;
export type UpdateTraderInput = z.infer<typeof updateTraderSchema>;
export type ListTradersQuery = z.infer<typeof listTradersQuerySchema>;
export type LookupTradersQuery = z.infer<typeof lookupTradersQuerySchema>;

export const traderSchema = z.object({
  id: z.uuid(),
  type: z.enum(TRADER_TYPES),
  name: z.string(),
  fatherName: z.string().nullable(),
  phone: z.string().nullable(),
  cnic: z.string().nullable(),
  village: z.string().nullable(),
  address: z.string().nullable(),
  /** Rupees, e.g. "50000.00" */
  openingBalance: z.string(),
  openingBalanceType: z.enum(BALANCE_TYPES),
  creditLimit: z.string().nullable(),
  isActive: z.boolean(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const traderDetailSchema = traderSchema.extend({
  /**
   * Sum of the khata, debit minus credit, e.g. "-50000.00": positive = the
   * trader owes the shop, negative = the shop owes the trader.
   */
  balance: z.string(),
});

export const traderLookupItemSchema = traderSchema.pick({
  id: true,
  type: true,
  name: true,
  fatherName: true,
  phone: true,
  village: true,
});

export type Trader = z.infer<typeof traderSchema>;
export type TraderDetail = z.infer<typeof traderDetailSchema>;
export type TraderLookupItem = z.infer<typeof traderLookupItemSchema>;

export class CreateTraderDto extends createZodDto(createTraderSchema) {}
export class UpdateTraderDto extends createZodDto(updateTraderSchema) {}
export class ListTradersQueryDto extends createZodDto(listTradersQuerySchema) {}
export class LookupTradersQueryDto extends createZodDto(
  lookupTradersQuerySchema,
) {}
export class TraderDto extends createZodDto(traderSchema) {}
export class TraderDetailDto extends createZodDto(traderDetailSchema) {}
export class TraderListDto extends createZodDto(
  z.object({
    data: z.array(traderSchema),
    meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }),
  }),
) {}
export class TraderLookupDto extends createZodDto(
  z.object({ data: z.array(traderLookupItemSchema) }),
) {}
