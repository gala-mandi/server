import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const DAY_MS = 86_400_000;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

// Strings in, Date out: Swagger can describe strings but not Date objects.
function dateParam(endOfDay: boolean) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) return undefined;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        ctx.addIssue({ code: 'custom', message: 'Invalid date' });
        return z.NEVER;
      }
      return endOfDay && dateOnly.test(value)
        ? new Date(date.getTime() + DAY_MS)
        : date;
    });
}

export const auditLogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  userId: z.uuid().optional(),
  entity: z.string().trim().min(1).max(40).optional(),
  entityId: z.uuid().optional(),
  action: z
    .enum(['create', 'update', 'delete', 'restore', 'access'])
    .optional(),
  /** From this moment (a date means its start, UTC). */
  from: dateParam(false),
  /** Up to this moment; a date like 2026-10-27 includes that whole day. */
  to: dateParam(true),
});

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const auditLogSchema = z.object({
  id: z.number().int(),
  userId: z.uuid().nullable(),
  entity: z.string(),
  entityId: z.uuid(),
  action: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const auditLogPageSchema = z.object({
  data: z.array(auditLogSchema),
  meta: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
  }),
});

export class AuditLogQueryDto extends createZodDto(auditLogQuerySchema) {}
export class AuditLogPageDto extends createZodDto(auditLogPageSchema) {}

export const restoreResultSchema = z.object({
  id: z.uuid(),
  restored: z.literal(true),
});
export class RestoreResultDto extends createZodDto(restoreResultSchema) {}
