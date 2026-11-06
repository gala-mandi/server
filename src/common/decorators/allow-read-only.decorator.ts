import { SetMetadata } from '@nestjs/common';

export const ALLOW_READ_ONLY_KEY = 'allowReadOnly';

/**
 * A write that still works when the shop's plan has run out (read-only
 * mode), e.g. signing in and out or changing the password.
 */
export const AllowReadOnly = () => SetMetadata(ALLOW_READ_ONLY_KEY, true);
