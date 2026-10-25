import { readCookie } from './cookies';

describe('readCookie', () => {
  it('reads one cookie among several', () => {
    expect(readCookie('a=1; refresh_token=abc.p; b=2', 'refresh_token')).toBe(
      'abc.p',
    );
  });

  it('returns undefined when missing', () => {
    expect(readCookie('a=1', 'refresh_token')).toBeUndefined();
    expect(readCookie(undefined, 'refresh_token')).toBeUndefined();
  });

  it('does not match a cookie whose name only ends the same', () => {
    expect(readCookie('xrefresh_token=bad', 'refresh_token')).toBeUndefined();
  });

  it('decodes URL-encoded values', () => {
    expect(readCookie('refresh_token=a%2Bb', 'refresh_token')).toBe('a+b');
  });
});
