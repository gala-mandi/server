import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth-user';

/** Shop endpoints: the token must carry a tenantId (super_admin has none). */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user?.tenantId) throw new ForbiddenException('No shop selected');
    return true;
  }
}
