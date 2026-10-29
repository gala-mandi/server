import { BadRequestException } from '@nestjs/common';
import { checkLogo, LOGO_MAX_BYTES, LOGO_TOO_LARGE } from './logo-file';

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0];

/** A buffer of `size` bytes that starts with `header`. */
function bytes(header: number[], size = 64): Buffer {
  const buffer = Buffer.alloc(size, 0x20);
  Buffer.from(header).copy(buffer);
  return buffer;
}

const file = (buffer: Buffer) => ({ buffer, size: buffer.length });

/** The response body the client would get for the thrown error. */
function errorOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse();
  }
  throw new Error('expected checkLogo to throw');
}

describe('checkLogo()', () => {
  it('accepts a PNG by its bytes', () => {
    const body = bytes(PNG_HEADER);

    expect(checkLogo(file(body))).toEqual({
      body,
      ext: 'png',
      contentType: 'image/png',
    });
  });

  it('accepts a JPG by its bytes', () => {
    const body = bytes(JPEG_HEADER);

    expect(checkLogo(file(body))).toEqual({
      body,
      ext: 'jpg',
      contentType: 'image/jpeg',
    });
  });

  it('accepts exactly 1 MB', () => {
    expect(checkLogo(file(bytes(PNG_HEADER, LOGO_MAX_BYTES))).ext).toBe('png');
  });

  it('refuses 1 MB + 1 byte with a clear message', () => {
    expect(
      errorOf(() => checkLogo(file(bytes(PNG_HEADER, LOGO_MAX_BYTES + 1)))),
    ).toEqual({
      message: LOGO_TOO_LARGE,
      code: 'FILE_TOO_LARGE',
      errors: [{ field: 'file', message: LOGO_TOO_LARGE }],
    });
    expect(LOGO_TOO_LARGE).toBe('The logo must be 1 MB or smaller');
  });

  it('refuses a PDF even when it is named logo.png', () => {
    const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n');

    expect(errorOf(() => checkLogo(file(pdf)))).toEqual({
      message: 'The logo must be a PNG or JPG image',
      code: 'INVALID_FILE_TYPE',
      errors: [
        { field: 'file', message: 'The logo must be a PNG or JPG image' },
      ],
    });
  });

  it.each([
    ['GIF', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    ['WebP', [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]],
    ['SVG', [...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')]],
    ['a truncated PNG header', PNG_HEADER.slice(0, 7)],
    ['a truncated JPG header', JPEG_HEADER.slice(0, 2)],
  ])('refuses %s', (_name, header) => {
    const body = Buffer.from(header);

    expect(errorOf(() => checkLogo(file(body)))).toMatchObject({
      code: 'INVALID_FILE_TYPE',
    });
  });

  it('refuses no file', () => {
    expect(errorOf(() => checkLogo(undefined))).toEqual({
      message: 'Choose a logo image',
      code: 'FILE_REQUIRED',
      errors: [{ field: 'file', message: 'Choose a logo image' }],
    });
  });

  it('refuses an empty file as no file', () => {
    expect(errorOf(() => checkLogo(file(Buffer.alloc(0))))).toMatchObject({
      code: 'FILE_REQUIRED',
    });
  });
});
