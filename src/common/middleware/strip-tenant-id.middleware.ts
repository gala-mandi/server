import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/** Body keys a client may never set: the shop comes only from the token. */
const TENANT_KEYS = new Set(['tenant_id', 'tenantId']);

/**
 * Removes `tenant_id` / `tenantId` from a parsed JSON body, at every depth
 * (for example inside purchase items). Other keys are left as they are.
 */
export function stripTenantId(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripTenantId(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (TENANT_KEYS.has(key)) delete record[key];
    else stripTenantId(record[key]);
  }
}

/**
 * Ignores any `tenant_id` the client sends, so a record is always saved under
 * the shop in the access token. Runs on every route, after body parsing.
 */
@Injectable()
export class StripTenantIdMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    stripTenantId(req.body);
    next();
  }
}
