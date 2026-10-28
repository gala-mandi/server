import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const phone = z
  .string()
  .trim()
  .regex(/^[+\d][\d\s-]{6,19}$/, 'Enter a valid phone number');

export const createInvitationSchema = z
  .object({
    phone,
    role: z.enum(['manager', 'operator']),
    /** `link`: send an invite link. `password`: create the account now. */
    method: z.enum(['link', 'password']).default('link'),
    name: z.string().trim().min(2).max(120).optional(),
  })
  .refine((v) => v.method !== 'password' || Boolean(v.name), {
    path: ['name'],
    message: "Enter the staff member's name",
  });

export const invitationSchema = z.object({
  id: z.uuid(),
  phone: z.string(),
  role: z.enum(['manager', 'operator']),
  status: z.enum(['pending', 'accepted', 'cancelled', 'expired']),
  invitedBy: z.uuid(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

/**
 * `method: 'link'` → `invitation` + `inviteUrl` (shown once so the owner can
 * also share it). `method: 'password'` → `user` + `temporaryPassword`
 * (shown once; the user must change it at first sign-in).
 */
export const createdInvitationSchema = z.object({
  method: z.enum(['link', 'password']),
  invitation: invitationSchema.optional(),
  inviteUrl: z.url().optional(),
  user: z
    .object({
      id: z.uuid(),
      name: z.string(),
      phone: z.string(),
      role: z.enum(['manager', 'operator']),
    })
    .optional(),
  temporaryPassword: z.string().optional(),
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
export type CreatedInvitation = z.infer<typeof createdInvitationSchema>;

export class CreateInvitationDto extends createZodDto(createInvitationSchema) {}
export class InvitationDto extends createZodDto(invitationSchema) {}
export class InvitationListDto extends createZodDto(
  z.object({ data: z.array(invitationSchema) }),
) {}
export class CreatedInvitationDto extends createZodDto(
  createdInvitationSchema,
) {}
