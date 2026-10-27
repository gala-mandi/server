import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { tenantStatus } from '../../database/schema';

const phone = z
  .string()
  .trim()
  .regex(/^[+\d][\d\s-]{6,19}$/, 'Enter a valid phone number');
const email = z.email('Enter a valid email').max(160);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

export const createTenantSchema = z.object({
  name: z.string().trim().min(2, 'Enter the shop name').max(120),
  city: optionalText(80),
  address: optionalText(500),
  phone,
  email: email.nullish().transform((v) => v || null),
  owner: z.object({
    name: z.string().trim().min(2, "Enter the owner's name").max(120),
    phone,
    email: email.nullish().transform((v) => v || null),
  }),
});

export const updateTenantSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    city: optionalText(80),
    address: optionalText(500),
    phone,
    email: email.nullable(),
    logoUrl: z.url().max(500).nullable(),
  })
  .partial();

export const listTenantsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  status: z.enum(tenantStatus.enumValues).optional(),
  sort: z
    .enum(['createdAt', '-createdAt', 'name', '-name'])
    .default('-createdAt'),
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;
export type ListTenantsQuery = z.infer<typeof listTenantsQuerySchema>;

export const tenantSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  city: z.string().nullable(),
  phone: z.string(),
  ownerName: z.string(),
  status: z.enum(tenantStatus.enumValues),
  userCount: z.number().int(),
  createdAt: z.iso.datetime(),
});

export const tenantDetailSchema = tenantSummarySchema.extend({
  email: z.string().nullable(),
  address: z.string().nullable(),
  logoUrl: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  owner: z
    .object({
      id: z.uuid(),
      name: z.string(),
      phone: z.string(),
      email: z.string().nullable(),
      isActive: z.boolean(),
      mustChangePassword: z.boolean(),
    })
    .nullable(),
});

export type TenantSummary = z.infer<typeof tenantSummarySchema>;
export type TenantDetail = z.infer<typeof tenantDetailSchema>;

export class CreateTenantDto extends createZodDto(createTenantSchema) {}
export class UpdateTenantDto extends createZodDto(updateTenantSchema) {}
export class ListTenantsQueryDto extends createZodDto(listTenantsQuerySchema) {}
export class TenantDetailDto extends createZodDto(tenantDetailSchema) {}
export class TenantPageDto extends createZodDto(
  z.object({
    data: z.array(tenantSummarySchema),
    meta: z.object({
      page: z.number().int(),
      limit: z.number().int(),
      total: z.number().int(),
    }),
  }),
) {}
export class CreatedTenantDto extends createZodDto(
  z.object({ tenant: tenantDetailSchema, temporaryPassword: z.string() }),
) {}
