import type { CookieOptions, Response } from 'express';

export const REFRESH_COOKIE = 'refresh_token';

export interface RefreshCookieConfig {
  secure: boolean;
  domain?: string;
  maxAgeMs: number;
}

function baseOptions(config: RefreshCookieConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.secure,
    sameSite: 'lax',
    path: '/',
    ...(config.domain && { domain: config.domain }),
  };
}

/** Without "keep me signed in" the cookie ends with the browser session. */
export function setRefreshCookie(
  res: Response,
  token: string,
  persistent: boolean,
  config: RefreshCookieConfig,
): void {
  res.cookie(REFRESH_COOKIE, token, {
    ...baseOptions(config),
    ...(persistent && { maxAge: config.maxAgeMs }),
  });
}

export function clearRefreshCookie(
  res: Response,
  config: RefreshCookieConfig,
): void {
  res.clearCookie(REFRESH_COOKIE, baseOptions(config));
}
