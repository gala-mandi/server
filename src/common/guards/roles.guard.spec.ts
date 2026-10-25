import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser, Role } from '../auth/auth-user';
import { RolesGuard } from './roles.guard';

function contextFor(user: Partial<AuthUser> | undefined): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function guardWith(roles: Role[] | undefined): RolesGuard {
  const reflector = { getAllAndOverride: () => roles } as unknown as Reflector;
  return new RolesGuard(reflector);
}

describe('RolesGuard', () => {
  it('allows any logged-in user when no roles are set', () => {
    expect(
      guardWith(undefined).canActivate(contextFor({ role: 'operator' })),
    ).toBe(true);
  });

  it('allows a listed role', () => {
    expect(
      guardWith(['owner']).canActivate(contextFor({ role: 'owner' })),
    ).toBe(true);
  });

  it.each<Role>(['operator', 'manager', 'super_admin'])(
    'rejects %s on an owner-only route',
    (role) => {
      expect(() =>
        guardWith(['owner']).canActivate(contextFor({ role })),
      ).toThrow(ForbiddenException);
    },
  );

  it('rejects when there is no user', () => {
    expect(() =>
      guardWith(['owner']).canActivate(contextFor(undefined)),
    ).toThrow(ForbiddenException);
  });
});
