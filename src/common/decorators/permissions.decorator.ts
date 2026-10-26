import { SetMetadata } from '@nestjs/common';
import type { Permission } from '../auth/permissions';

export const PERMISSIONS_KEY = 'permissions';

/** The user's role must grant all of these. Checked by `PermissionsGuard`. */
export const Permissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
