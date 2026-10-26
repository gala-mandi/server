import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Open route: no access token needed. Every other route requires one. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
