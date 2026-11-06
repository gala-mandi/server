import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthenticatedRequest } from '../../common/auth/auth-user';
import { ALLOW_READ_ONLY_KEY } from '../../common/decorators/allow-read-only.decorator';
import { subscriptionReadOnly } from './subscription-errors';
import { SubscriptionsService } from './subscriptions.service';

/** Reads never change anything: always allowed, also in read-only mode. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global, after the role checks: when a shop's plan is past its grace
 * period, every write by its users is refused with 403
 * `SUBSCRIPTION_READ_ONLY`; viewing and printing keep working. Routes marked
 * `@AllowReadOnly()` (signing in/out, password) are left alone, and so is the
 * super-admin (no shop). The state comes from the dates on each request, so
 * an extension unlocks the shop at once.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context
      .switchToHttp()
      .getRequest<Request & AuthenticatedRequest>();
    if (SAFE_METHODS.has(req.method)) return true;
    if (!req.user?.tenantId) return true;

    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_READ_ONLY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return true;

    if ((await this.subscriptions.accessState()) === 'read_only') {
      throw subscriptionReadOnly();
    }
    return true;
  }
}
