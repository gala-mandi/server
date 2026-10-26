import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth/auth-user';
import { type Permission, roleHas } from '../auth/permissions';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

/**
 * Global: when a route has `@Permissions()`, the user's role must grant all
 * of them. The role comes from the access token, so a role change applies on
 * the next token refresh.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user || !required.every((p) => roleHas(user.role, p))) {
      throw new ForbiddenException('You do not have access to this action');
    }
    return true;
  }
}
