import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '../auth/auth-user';
import { type Permission, ROLE_PERMISSIONS } from '../auth/permissions';
import { PermissionsGuard } from './permissions.guard';

function contextFor(role: Role | undefined): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({ user: role ? { role } : undefined }),
    }),
  } as unknown as ExecutionContext;
}

function guardWith(required: Permission[] | undefined): PermissionsGuard {
  const reflector = {
    getAllAndOverride: () => required,
  } as unknown as Reflector;
  return new PermissionsGuard(reflector);
}

const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];

describe('PermissionsGuard', () => {
  it('lets a route without @Permissions through', () => {
    expect(guardWith(undefined).canActivate(contextFor('operator'))).toBe(true);
    expect(guardWith([]).canActivate(contextFor('operator'))).toBe(true);
  });

  describe.each<Permission>([
    'purchase.delete',
    'staff.manage',
    'report.view',
    'purchase.create',
    'tenant.manage',
  ])('%s', (permission) => {
    it.each(ROLES)('follows the matrix for %s', (role) => {
      const guard = guardWith([permission]);
      const allowed = ROLE_PERMISSIONS[role].includes(permission);

      if (allowed) {
        expect(guard.canActivate(contextFor(role))).toBe(true);
      } else {
        expect(() => guard.canActivate(contextFor(role))).toThrow(
          ForbiddenException,
        );
      }
    });
  });

  it('needs every listed permission', () => {
    const guard = guardWith(['purchase.view', 'purchase.delete']);

    expect(guard.canActivate(contextFor('owner'))).toBe(true);
    expect(() => guard.canActivate(contextFor('manager'))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects when there is no user', () => {
    expect(() =>
      guardWith(['rate.view']).canActivate(contextFor(undefined)),
    ).toThrow(ForbiddenException);
  });
});
