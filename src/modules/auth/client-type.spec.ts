import type { Request } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import { bodyRefreshToken, isMobileClient } from './client-type';

const req = (headers: Record<string, unknown>, body?: unknown) =>
  ({ headers, body }) as unknown as Request;

describe('client-type', () => {
  it.each([
    ['mobile', true],
    ['Mobile', true],
    [' mobile ', true],
    ['web', false],
    ['', false],
  ])('X-Client %j is mobile: %s', (value, expected) => {
    expect(isMobileClient(req({ 'x-client': value }))).toBe(expected);
  });

  it('no X-Client header is the web', () => {
    expect(isMobileClient(req({}))).toBe(false);
  });

  it('a repeated header (array) is not trusted as mobile', () => {
    expect(isMobileClient(req({ 'x-client': ['mobile', 'mobile'] }))).toBe(
      false,
    );
  });

  it('reads the refresh token from the body', () => {
    expect(bodyRefreshToken(req({}, { refreshToken: 'abc.p' }))).toBe('abc.p');
  });

  it.each([undefined, {}, { refreshToken: '' }, { refreshToken: '   ' }])(
    'a missing token (%j) is undefined, answered like a missing cookie',
    (body) => {
      expect(bodyRefreshToken(req({}, body))).toBeUndefined();
    },
  );

  it.each([{ refreshToken: 42 }, { refreshToken: 'x'.repeat(201) }])(
    'a malformed body (%j) is a validation error',
    (body) => {
      expect(() => bodyRefreshToken(req({}, body))).toThrow(
        ZodValidationException,
      );
    },
  );
});
