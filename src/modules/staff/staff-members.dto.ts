import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const shopRole = z.enum(['owner', 'manager', 'operator']);

export const staffMemberSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  role: shopRole,
  isActive: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
  mustChangePassword: z.boolean(),
  createdAt: z.iso.datetime(),
  /** The signed-in user (can't deactivate themselves). */
  isYou: z.boolean(),
});

export class StaffMemberDto extends createZodDto(staffMemberSchema) {}
export class StaffListDto extends createZodDto(
  z.object({ data: z.array(staffMemberSchema) }),
) {}
export class ChangeRoleDto extends createZodDto(z.object({ role: shopRole })) {}
