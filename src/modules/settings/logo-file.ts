import { BadRequestException } from '@nestjs/common';

export const LOGO_MAX_BYTES = 1024 * 1024;
export const LOGO_TOO_LARGE = 'The logo must be 1 MB or smaller';

export interface LogoFile {
  body: Buffer;
  ext: 'png' | 'jpg';
  contentType: 'image/png' | 'image/jpeg';
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

const startsWith = (data: Buffer, bytes: number[]) =>
  data.length >= bytes.length && bytes.every((b, i) => data[i] === b);

const invalid = (message: string, code: string) =>
  new BadRequestException({
    message,
    code,
    errors: [{ field: 'file', message }],
  });

/**
 * Checks the file's own bytes, not its name or the browser's content type,
 * so a renamed PDF is still refused.
 */
export function checkLogo(
  file: { buffer: Buffer; size: number } | undefined,
): LogoFile {
  if (!file?.size) throw invalid('Choose a logo image', 'FILE_REQUIRED');
  if (file.size > LOGO_MAX_BYTES)
    throw invalid(LOGO_TOO_LARGE, 'FILE_TOO_LARGE');
  const body = file.buffer;
  if (startsWith(body, PNG))
    return { body, ext: 'png', contentType: 'image/png' };
  if (startsWith(body, JPEG))
    return { body, ext: 'jpg', contentType: 'image/jpeg' };
  throw invalid('The logo must be a PNG or JPG image', 'INVALID_FILE_TYPE');
}
