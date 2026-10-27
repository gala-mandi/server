import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PERMISSIONS } from '../../../common/auth/permissions';
import { tenantStatus, userRole } from '../../../database/schema';

export const userSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  role: z.enum(userRole.enumValues),
  tenantId: z.uuid().nullable(),
  mustChangePassword: z.boolean(),
  /** What this user's role may do; frontends use it to hide UI. */
  permissions: z.array(z.enum(PERMISSIONS)),
  tenant: z
    .object({
      id: z.uuid(),
      name: z.string(),
      logoUrl: z.string().nullable(),
      status: z.enum(tenantStatus.enumValues),
    })
    .nullable(),
});

export const sessionSchema = z.object({
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int(),
  user: userSchema,
});

export const revokedSessionsSchema = z.object({
  revokedSessions: z.number().int(),
});

export const forgotPasswordResultSchema = z.object({
  message: z.string(),
  expiresIn: z.number().int(),
  resendIn: z.number().int(),
});

export type UserDto = z.infer<typeof userSchema>;

export class UserResponseDto extends createZodDto(userSchema) {}
export class SessionDto extends createZodDto(sessionSchema) {}
export class RevokedSessionsDto extends createZodDto(revokedSessionsSchema) {}
export class ForgotPasswordResultDto extends createZodDto(
  forgotPasswordResultSchema,
) {}

export class AcceptedInviteDto extends createZodDto(
  z.object({ phone: z.string(), shopName: z.string() }),
) {}
