import {
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth-user';

export function currentTenantFactory(
  _data: unknown,
  ctx: ExecutionContext,
): string {
  const tenantId = ctx.switchToHttp().getRequest<AuthenticatedRequest>()
    .user?.tenantId;
  if (!tenantId) throw new ForbiddenException('No shop selected');
  return tenantId;
}

/**
 * The shop id from the access token — never from the body, params or query.
 * Use after `JwtAuthGuard` and `TenantGuard`.
 */
export const CurrentTenant = createParamDecorator(currentTenantFactory);
