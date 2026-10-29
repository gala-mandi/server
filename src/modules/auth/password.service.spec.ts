import { argon2Options, PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with argon2id and never stores the plain password', async () => {
    const hash = await service.hash('S3cret-pass');

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('S3cret-pass');
  });

  it('verifies the right password', async () => {
    const hash = await service.hash('S3cret-pass');

    await expect(service.verify(hash, 'S3cret-pass')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await service.hash('S3cret-pass');

    await expect(service.verify(hash, 'wrong')).resolves.toBe(false);
  });

  it('returns false for a missing user without throwing', async () => {
    await expect(service.verify(null, 'anything')).resolves.toBe(false);
  });

  it('returns false for a malformed hash', async () => {
    await expect(service.verify('not-a-hash', 'x')).resolves.toBe(false);
  });
});

describe('argon2Options', () => {
  it('uses argon2 defaults when nothing is set', () => {
    expect(argon2Options({})).toMatchObject({
      memoryCost: 65_536,
      timeCost: 3,
    });
  });

  it('takes lower values outside production (tests)', () => {
    expect(
      argon2Options({ ARGON2_MEMORY_KIB: '1024', ARGON2_TIME_COST: '1' }),
    ).toMatchObject({ memoryCost: 1024, timeCost: 1 });
  });

  it('refuses weak values in production', () => {
    expect(() =>
      argon2Options({
        NODE_ENV: 'production',
        ARGON2_MEMORY_KIB: '1024',
        ARGON2_TIME_COST: '1',
      }),
    ).toThrow(/ARGON2_MEMORY_KIB/);
  });
});
