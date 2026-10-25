import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';

function contextFor(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('TenantGuard', () => {
  const guard = new TenantGuard();

  it('allows a token with a tenantId', () => {
    expect(guard.canActivate(contextFor({ tenantId: 'shop-a' }))).toBe(true);
  });

  it('rejects super_admin (no tenantId)', () => {
    expect(() =>
      guard.canActivate(contextFor({ tenantId: null, role: 'super_admin' })),
    ).toThrow(ForbiddenException);
  });

  it('rejects a request without a user', () => {
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
