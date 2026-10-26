import { SetMetadata } from '@nestjs/common';
import type { Role } from '../auth/auth-user';

export const ROLES_KEY = 'roles';

/** Only these roles may call the route. Checked by `RolesGuard`. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
