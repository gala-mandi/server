import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Money travels as a string so no float rounding touches it.
const money = z
  .string('Enter a price in rupees')
  .trim()
  .regex(
    /^\d{1,12}(\.\d{1,2})?$/,
    'Enter a price in rupees (up to 2 decimals)',
  );

const count = (label: string, max: number) =>
  z.coerce
    .number(`Enter the ${label}`)
    .int(`Enter a whole number of ${label}`)
    .min(1, `Allow at least 1 of ${label}`)
    .max(max, `Use at most ${max} ${label}`);

export const createPlanSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Enter the plan name')
    .max(60, 'Use at most 60 characters'),
  maxUsers: count('users', 10_000),
  maxBranches: count('branches', 1_000).default(1),
  priceMonthly: money,
  isActive: z.boolean().default(true),
});

export const updatePlanSchema = z
  .object({
    name: createPlanSchema.shape.name,
    maxUsers: createPlanSchema.shape.maxUsers,
    maxBranches: count('branches', 1_000),
    priceMonthly: money,
    isActive: z.boolean(),
  })
  .partial();

export const listPlansQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(60).optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  sort: z
    .enum([
      'priceMonthly',
      '-priceMonthly',
      'name',
      '-name',
      'createdAt',
      '-createdAt',
    ])
    .default('priceMonthly'),
});

export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
export type ListPlansQuery = z.infer<typeof listPlansQuerySchema>;

export const planSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  maxUsers: z.number().int(),
  maxBranches: z.number().int(),
  priceMonthly: z.string().describe('Rupees, 2 decimals'),
  isActive: z.boolean(),
  /** Trial: every new shop starts on it; can't be renamed or deactivated. */
  isTrial: z.boolean(),
  /** Shops whose current subscription is this plan. */
  shopCount: z.number().int(),
  createdAt: z.iso.datetime(),
});

export type Plan = z.infer<typeof planSchema>;

export class CreatePlanDto extends createZodDto(createPlanSchema) {}
export class UpdatePlanDto extends createZodDto(updatePlanSchema) {}
export class ListPlansQueryDto extends createZodDto(listPlansQuerySchema) {}
export class PlanDto extends createZodDto(planSchema) {}
export class PlanPageDto extends createZodDto(
  z.object({
    data: z.array(planSchema),
    meta: z.object({
      page: z.number().int(),
      limit: z.number().int(),
      total: z.number().int(),
    }),
  }),
) {}
export class PlanRemovedDto extends createZodDto(
  z.object({
    /** deleted: no shop ever used it; deactivated: kept for their history. */
    result: z.enum(['deleted', 'deactivated']),
    plan: planSchema,
  }),
) {}
