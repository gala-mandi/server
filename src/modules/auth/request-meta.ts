import type { Request } from 'express';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function requestMeta(req: Request): RequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
  };
}
