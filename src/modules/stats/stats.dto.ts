import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { tenantStatus, userRole } from '../../database/schema';

/** A shop with nothing done by its own users for this long is "inactive". */
export const INACTIVE_DAYS = 14;

const count = z.number().int().min(0);

// Counts only: no shop's business amounts ever leave these endpoints.
export const platformStatsSchema = z.object({
  shops: z.object({
    total: count,
    trial: count,
    active: count,
    suspended: count,
    cancelled: count,
  }),
  users: z.object({
    /** Shop users (not the platform admin), deleted ones left out. */
    total: count,
    /** Of those: not deactivated, in a trial or active shop. */
    active: count,
  }),
});

export const newShopsQuerySchema = z.object({
  /** How many calendar months (Asia/Karachi), this month included. */
  months: z.coerce.number().int().min(1).max(36).default(12),
});

export const newShopsSchema = z.object({
  data: z.array(
    z.object({
      /** `YYYY-MM` */
      month: z.string().regex(/^\d{4}-\d{2}$/),
      count,
    }),
  ),
});

export const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// What happened, who and where; never the record's before/after values,
// which hold the shop's amounts.
export const activityItemSchema = z.object({
  id: z.number().int(),
  tenant: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  user: z
    .object({
      id: z.uuid(),
      name: z.string(),
      role: z.enum(userRole.enumValues),
    })
    .nullable(),
  entity: z.string(),
  entityId: z.uuid(),
  action: z.string(),
  createdAt: z.iso.datetime(),
});

export const activityFeedSchema = z.object({
  data: z.array(activityItemSchema),
});

export const inactiveShopsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const inactiveShopSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  city: z.string().nullable(),
  status: z.enum(tenantStatus.enumValues),
  /** Latest of: shop created, a shop user's audited change, a sign-in. */
  lastActivityAt: z.iso.datetime(),
});

export const inactiveShopPageSchema = z.object({
  data: z.array(inactiveShopSchema),
  meta: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
  }),
});

export type PlatformStats = z.infer<typeof platformStatsSchema>;
export type NewShopsQuery = z.infer<typeof newShopsQuerySchema>;
export type NewShops = z.infer<typeof newShopsSchema>;
export type ActivityQuery = z.infer<typeof activityQuerySchema>;
export type ActivityItem = z.infer<typeof activityItemSchema>;
export type ActivityFeed = z.infer<typeof activityFeedSchema>;
export type InactiveShopsQuery = z.infer<typeof inactiveShopsQuerySchema>;
export type InactiveShop = z.infer<typeof inactiveShopSchema>;
export type InactiveShopPage = z.infer<typeof inactiveShopPageSchema>;

export class PlatformStatsDto extends createZodDto(platformStatsSchema) {}
export class NewShopsQueryDto extends createZodDto(newShopsQuerySchema) {}
export class NewShopsDto extends createZodDto(newShopsSchema) {}
export class ActivityQueryDto extends createZodDto(activityQuerySchema) {}
export class ActivityFeedDto extends createZodDto(activityFeedSchema) {}
export class InactiveShopsQueryDto extends createZodDto(
  inactiveShopsQuerySchema,
) {}
export class InactiveShopPageDto extends createZodDto(inactiveShopPageSchema) {}
