import type { Request } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import { mobileRefreshSchema } from './dto/auth-requests.dto';

/**
 * The mobile app can't use the httpOnly refresh cookie, so it says who it is
 * with `X-Client: mobile`. It then gets the refresh token in the JSON body and
 * sends it back in the body; no cookie is set or read. Every other rule
 * (rotation, reuse detection, expiry, disabled account, suspended shop) is the
 * same, because both modes go through the same AuthService methods.
 */
export const CLIENT_HEADER = 'X-Client';
export const MOBILE_CLIENT = 'mobile';

export function isMobileClient(req: Request): boolean {
  const value = req.headers[CLIENT_HEADER.toLowerCase()];
  return (
    typeof value === 'string' && value.trim().toLowerCase() === MOBILE_CLIENT
  );
}

/**
 * The refresh token the mobile app sent in the body. A missing token is
 * `undefined` (answered like a missing cookie); a malformed body is a 400.
 */
export function bodyRefreshToken(req: Request): string | undefined {
  const parsed = mobileRefreshSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ZodValidationException(parsed.error);
  return parsed.data.refreshToken || undefined;
}
