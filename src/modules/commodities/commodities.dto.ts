import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { UNITS } from '../settings/settings.dto';

export type Unit = (typeof UNITS)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters`)
    .nullish()
    .transform((v) => v || null);

/**
 * An optional decimal: `null`, missing or "" mean "not set" (for charges:
 * use the shop default). Decimals travel as strings so no float rounding
 * touches them.
 */
const optionalDecimal = (pattern: RegExp, message: string) =>
  z
    .string()
    .trim()
    .nullish()
    .transform((v) => v || null)
    .refine((v) => v === null || pattern.test(v), message);

const percent = optionalDecimal(
  /^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/,
  'Enter a percentage from 0 to 100 (up to 2 decimals)',
);

// numeric(8,3): up to 99999.999 kg.
const BAG_WEIGHT = /^\d{1,5}(\.\d{1,3})?$/;

const fields = {
  name: z
    .string()
    .trim()
    .min(2, 'Enter the name')
    .max(80, 'Use at most 80 characters'),
  nameUr: optionalText(80),
  category: optionalText(40),
  defaultUnit: z.enum(UNITS, 'Choose kg, maund or bag'),
  bagWeightKg: optionalDecimal(
    BAG_WEIGHT,
    'Enter the bag weight in kg (up to 3 decimals)',
  ).refine(
    // One message per problem: "0" is well-formed but not more than 0.
    (v) => v === null || !BAG_WEIGHT.test(v) || /[1-9]/.test(v),
    'Bag weight must be more than 0',
  ),
  commissionPct: percent,
  marketFeePct: percent,
  labourPerBag: optionalDecimal(
    /^\d{1,12}(\.\d{1,2})?$/,
    'Enter an amount in rupees (up to 2 decimals)',
  ),
  isActive: z.boolean(),
};

export const createCommoditySchema = z
  .object({
    ...fields,
    defaultUnit: fields.defaultUnit.default('maund'),
    isActive: fields.isActive.default(true),
  })
  .strict();

export const updateCommoditySchema = z.object(fields).partial().strict();

export const listCommoditiesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(80).optional(),
  category: z.string().trim().max(40).optional(),
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  sort: z.enum(['name', '-name', 'createdAt', '-createdAt']).default('name'),
});

export const lookupCommoditiesQuerySchema = z.object({
  q: z.string().trim().max(80).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type CreateCommodityInput = z.infer<typeof createCommoditySchema>;
export type UpdateCommodityInput = z.infer<typeof updateCommoditySchema>;
export type ListCommoditiesQuery = z.infer<typeof listCommoditiesQuerySchema>;
export type LookupCommoditiesQuery = z.infer<
  typeof lookupCommoditiesQuerySchema
>;

export const commoditySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  nameUr: z.string().nullable(),
  category: z.string().nullable(),
  defaultUnit: z.enum(UNITS),
  /** Kg per bag, e.g. "100.000"; null = the shop sets it per purchase. */
  bagWeightKg: z.string().nullable(),
  /** Overrides: null = the shop default from settings. */
  commissionPct: z.string().nullable(),
  marketFeePct: z.string().nullable(),
  labourPerBag: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** Charges that apply: the commodity's own value, else the shop default. */
export const effectiveChargesSchema = z.object({
  commissionPct: z.string(),
  marketFeePct: z.string(),
  labourPerBag: z.string(),
});

export const commodityLookupItemSchema = commoditySchema
  .pick({
    id: true,
    name: true,
    nameUr: true,
    defaultUnit: true,
    bagWeightKg: true,
  })
  .extend({ charges: effectiveChargesSchema });

export type Commodity = z.infer<typeof commoditySchema>;
export type EffectiveCharges = z.infer<typeof effectiveChargesSchema>;
export type CommodityLookupItem = z.infer<typeof commodityLookupItemSchema>;

export class CreateCommodityDto extends createZodDto(createCommoditySchema) {}
export class UpdateCommodityDto extends createZodDto(updateCommoditySchema) {}
export class ListCommoditiesQueryDto extends createZodDto(
  listCommoditiesQuerySchema,
) {}
export class LookupCommoditiesQueryDto extends createZodDto(
  lookupCommoditiesQuerySchema,
) {}
export class CommodityDto extends createZodDto(commoditySchema) {}
export class CommodityListDto extends createZodDto(
  z.object({
    data: z.array(commoditySchema),
    meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }),
  }),
) {}
export class CommodityLookupDto extends createZodDto(
  z.object({ data: z.array(commodityLookupItemSchema) }),
) {}
