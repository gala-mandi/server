import { validateEnv } from './env.schema';

const validEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/galla_mandi',
  CORS_ORIGINS: 'http://localhost:3000, http://localhost:3001',
};

describe('validateEnv', () => {
  it('accepts a valid env and applies defaults', () => {
    const env = validateEnv(validEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
    expect(env.THROTTLE_TTL_MS).toBe(60_000);
    expect(env.THROTTLE_LIMIT).toBe(100);
    expect(env.LOG_LEVEL).toBe('info');
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
    expect(() => validateEnv({ CORS_ORIGINS: validEnv.CORS_ORIGINS })).toThrow(
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
