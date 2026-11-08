import { validateEnv } from './env.schema';

const validEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/galla_mandi',
  CORS_ORIGINS: 'http://localhost:3000, http://localhost:3001',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  OTP_SECRET: 'b'.repeat(32),
};

describe('validateEnv', () => {
  it('accepts a valid env and applies defaults', () => {
    const env = validateEnv(validEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
    expect(env.THROTTLE_TTL_MS).toBe(60_000);
    expect(env.THROTTLE_LIMIT).toBe(100);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.JWT_ACCESS_TTL_SEC).toBe(900);
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(7);
    expect(env.LOGIN_THROTTLE_LIMIT).toBe(5);
  });

  it('rejects a short JWT secret', () => {
    expect(() =>
      validateEnv({ ...validEnv, JWT_ACCESS_SECRET: 'short' }),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('splits CORS_ORIGINS into a trimmed list', () => {
    expect(validateEnv(validEnv).CORS_ORIGINS).toEqual([
      'http://localhost:3000',
      'http://localhost:3001',
    ]);
  });

  it('coerces numbers from strings', () => {
    const env = validateEnv({ ...validEnv, PORT: '8080', THROTTLE_LIMIT: '5' });

    expect(env.PORT).toBe(8080);
    expect(env.THROTTLE_LIMIT).toBe(5);
  });

  it('fails with a clear message when DATABASE_URL is missing', () => {
    expect(() => validateEnv({ ...validEnv, DATABASE_URL: undefined })).toThrow(
      /Invalid environment variables:\n {2}- DATABASE_URL:/,
    );
  });

  it('rejects a DATABASE_URL that is not postgres', () => {
    expect(() =>
      validateEnv({ ...validEnv, DATABASE_URL: 'mysql://localhost/db' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('rejects a wrong value type', () => {
    expect(() => validateEnv({ ...validEnv, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...validEnv, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
  });

  it('rejects a CORS origin that is not a URL', () => {
    expect(() =>
      validateEnv({ ...validEnv, CORS_ORIGINS: 'not-a-url' }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it('reduces CORS origins to the exact origin and refuses a wildcard', () => {
    expect(
      validateEnv({
        ...validEnv,
        CORS_ORIGINS:
          'https://web.example.com/, https://admin.example.com/login',
      }).CORS_ORIGINS,
    ).toEqual(['https://web.example.com', 'https://admin.example.com']);
    expect(() => validateEnv({ ...validEnv, CORS_ORIGINS: '*' })).toThrow(
      /CORS_ORIGINS/,
    );
  });

  it('treats Sentry as off when SENTRY_DSN is unset or empty', () => {
    expect(validateEnv(validEnv).SENTRY_DSN).toBeUndefined();
    expect(
      validateEnv({ ...validEnv, SENTRY_DSN: '' }).SENTRY_DSN,
    ).toBeUndefined();
    expect(() => validateEnv({ ...validEnv, SENTRY_DSN: 'not-a-dsn' })).toThrow(
      /SENTRY_DSN/,
    );
  });

  it('lists every problem at once', () => {
    let message = '';
    try {
      validateEnv({ PORT: 'abc' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('CORS_ORIGINS');
    expect(message).toContain('PORT');
  });
});
