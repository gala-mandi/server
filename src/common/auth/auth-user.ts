import type { userRole } from '../../database/schema';

export type Role = (typeof userRole.enumValues)[number];

/** Claims inside the access token. */
export interface AccessTokenPayload {
  sub: string;
  tenantId: string | null;
  role: Role;
  /** Session id: the refresh-token family this access token belongs to. */
  sid: string;
}

/** What `@CurrentUser()` returns after the JWT strategy has run. */
export interface AuthUser {
  id: string;
  tenantId: string | null;
  role: Role;
  sessionId: string;
}

export interface AuthenticatedRequest {
  user?: AuthUser;
}
