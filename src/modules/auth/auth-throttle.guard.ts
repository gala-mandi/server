import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getStorageToken, type ThrottlerStorage } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { Env } from '../../config/env.schema';
import { AuthLogService } from './auth-log.service';
import { parseIdentifier } from './identifier';
import { requestMeta } from './request-meta';

const THROTTLER_NAME = 'auth';

/**
 * Brute-force protection for login and forgot-password:
 * LOGIN_THROTTLE_LIMIT attempts per LOGIN_THROTTLE_TTL_MS for each
 * route + IP + phone/email, then a pause. Other phones from the same IP
 * are not affected.
 */
@Injectable()
export class AuthThrottleGuard implements CanActivate {
  constructor(
    @Inject(getStorageToken()) private readonly storage: ThrottlerStorage,
    private readonly config: ConfigService<Env, true>,
    private readonly authLog: AuthLogService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const limit = this.config.get('LOGIN_THROTTLE_LIMIT', { infer: true });
    const ttl = this.config.get('LOGIN_THROTTLE_TTL_MS', { infer: true });
    const body = req.body as
      { identifier?: unknown; phone?: unknown } | undefined;
    const raw = body?.identifier ?? body?.phone;
    const identifier =
      typeof raw === 'string' ? parseIdentifier(raw).value : '';
    const key = `${req.path}:${req.ip}:${identifier}`;

    const record = await this.storage.increment(
      key,
      ttl,
      limit,
      ttl,
      THROTTLER_NAME,
    );
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader(
      'X-RateLimit-Remaining',
      Math.max(0, limit - record.totalHits),
    );

    if (record.isBlocked) {
      res.setHeader('Retry-After', Math.max(1, record.timeToBlockExpire));
      await this.authLog.write({ action: 'locked', meta: requestMeta(req) });
      throw new HttpException(
        'Too many attempts. Try again in a minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
