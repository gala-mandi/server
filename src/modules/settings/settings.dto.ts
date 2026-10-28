import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UNITS = ['kg', 'maund', 'bag'] as const;
export const LANGUAGES = ['en', 'ur'] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters`)
    .nullish()
    .transform((v) => v || null);

// Decimals travel as strings so no float rounding touches them.
const percent = z
  .string()
  .trim()
  .regex(
    /^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/,
    'Enter a percentage from 0 to 100 (up to 2 decimals)',
  );
const money = z
  .string()
  .trim()
  .regex(
    /^\d{1,12}(\.\d{1,2})?$/,
    'Enter an amount in rupees (up to 2 decimals)',
  );

export const updateSettingsSchema = z
  .object({
    // Shop profile (stored on `tenants`)
    name: z
      .string()
      .trim()
      .min(2, 'Enter the shop name')
      .max(120, 'Use at most 120 characters'),
    phone: z
      .string()
      .trim()
      .regex(/^[+\d][\d\s-]{6,19}$/, 'Enter a valid phone number'),
    email: z
      .email('Enter a valid email')
      .max(160)
      .or(z.literal(''))
      .nullish()
      .transform((v) => v || null),
    address: optionalText(500),
    city: optionalText(80),
    /** Only `null` (remove the logo); a new one goes through POST /settings/logo. */
    logoUrl: z.null(),
    // Parchi
    displayName: optionalText(120),
    parchiFooter: optionalText(500),
    // Charges & commission
    defaultCommissionPct: percent,
    marketFeePct: percent,
    labourPerBag: money,
    // Units
    defaultUnit: z.enum(UNITS, 'Choose kg, maund or bag'),
    maundKg: z
      .string()
      .trim()
      .regex(/^\d{1,3}(\.\d{1,3})?$/, 'Enter kg per maund (up to 3 decimals)')
      .refine((v) => /[1-9]/.test(v), 'Kg per maund must be more than 0'),
    language: z.enum(LANGUAGES, 'Choose English or Urdu'),
    // Numbering
    billPrefix: z
      .string()
      .trim()
      .max(10, 'Use at most 10 characters')
      .regex(/^[A-Za-z0-9/-]*$/, 'Use letters, digits, - or / only')
      .nullish()
      .transform((v) => v || null),
    financialYearStart: z.iso
      .date('Enter a date as YYYY-MM-DD')
      .or(z.literal(''))
      .nullish()
      .transform((v) => v || null),
  })
  .partial()
  .strict();

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const settingsSchema = z.object({
  name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  logoUrl: z.string().nullable(),
  displayName: z.string().nullable(),
  parchiFooter: z.string().nullable(),
  /** e.g. "2.50" */
  defaultCommissionPct: z.string(),
  marketFeePct: z.string(),
  /** Rupees, e.g. "15.00" */
  labourPerBag: z.string(),
  defaultUnit: z.enum(UNITS),
  /** e.g. "40.000"; weight conversions use it. */
  maundKg: z.string(),
  billPrefix: z.string().nullable(),
  /** YYYY-MM-DD */
  financialYearStart: z.string().nullable(),
  language: z.enum(LANGUAGES),
  updatedAt: z.iso.datetime(),
});

export type Settings = z.infer<typeof settingsSchema>;

export class UpdateSettingsDto extends createZodDto(updateSettingsSchema) {}
export class SettingsDto extends createZodDto(settingsSchema) {}
