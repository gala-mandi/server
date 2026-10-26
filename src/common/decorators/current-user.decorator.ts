import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedRequest, AuthUser } from '../auth/auth-user';

export function currentUserFactory(
  _data: unknown,
  ctx: ExecutionContext,
): AuthUser {
  const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
  if (!user) throw new UnauthorizedException();
  return user;
}

/** The logged-in user from the access token. Use after `JwtAuthGuard`. */
export const CurrentUser = createParamDecorator(currentUserFactory);
