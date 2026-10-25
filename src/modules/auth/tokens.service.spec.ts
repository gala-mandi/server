import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Database } from '../../database/database.module';
import type { UserRow } from './auth-users.service';
import { hashToken, isPersistent, TokensService } from './tokens.service';

const secret = 'x'.repeat(32);
const jwt = new JwtService({
  secret,
  signOptions: { algorithm: 'HS256', expiresIn: 900 },
});
const config = {
  get: (key: string) =>
    ({ JWT_ACCESS_TTL_SEC: 900, REFRESH_TOKEN_TTL_DAYS: 7 })[key],
} as unknown as ConfigService;

const owner = {
  id: '00000000-0000-0000-0000-000000000001',
  tenantId: '00000000-0000-0000-0000-0000000000aa',
  role: 'owner',
} as UserRow;

describe('TokensService', () => {
  const service = new TokensService({} as Database, jwt, config as never);

  it('puts sub, tenantId, role and session id in the access token', async () => {
    const token = await service.signAccessToken(owner, 'family-1');
    const payload = jwt.verify<Record<string, unknown>>(token);

    expect(payload).toMatchObject({
      sub: owner.id,
      tenantId: owner.tenantId,
      role: 'owner',
      sid: 'family-1',
    });
    expect((payload.exp as number) - (payload.iat as number)).toBe(900);
  });

  it('gives super_admin a token without a tenant', async () => {
    const token = await service.signAccessToken(
      { ...owner, tenantId: null, role: 'super_admin' },
      'family-2',
    );

    expect(jwt.verify(token)).toMatchObject({
      tenantId: null,
      role: 'super_admin',
    });
  });

  it('uses a 7-day refresh lifetime', () => {
    expect(service.refreshTtlMs).toBe(7 * 86_400_000);
  });

  it('hashes refresh tokens with sha256', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('reads the persistent flag from the token', () => {
    expect(isPersistent('random.p')).toBe(true);
    expect(isPersistent('random.s')).toBe(false);
  });
});
