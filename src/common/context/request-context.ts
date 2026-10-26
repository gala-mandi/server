import type { ClsStore } from 'nestjs-cls';
import type { Role } from '../auth/auth-user';

/**
 * Per-request values (nestjs-cls / AsyncLocalStorage). `ip` is set for every
 * request; `userId`, `tenantId` and `role` after the JWT strategy has run.
 */
export interface RequestContext extends ClsStore {
  ip?: string;
  userId?: string;
  tenantId?: string | null;
  role?: Role;
}
