import { PasswordService } from './password.service';

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
