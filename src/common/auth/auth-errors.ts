import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

/** Machine-readable codes so the frontend can pick the right screen. */
export const AuthErrorCode = {
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  INVALID_OTP: 'INVALID_OTP',
} as const;

export const accountDisabled = () =>
  new ForbiddenException({
    message: 'Account disabled',
    code: AuthErrorCode.ACCOUNT_DISABLED,
  });

export const tenantSuspended = () =>
  new ForbiddenException({
    message: 'Shop suspended, contact support',
    code: AuthErrorCode.TENANT_SUSPENDED,
  });

export const invalidCredentials = () =>
  new UnauthorizedException('Invalid credentials');

export const sessionExpired = () =>
  new UnauthorizedException({
    message: 'Session expired',
    code: AuthErrorCode.SESSION_EXPIRED,
  });
