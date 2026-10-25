import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { currentTenantFactory } from './current-tenant.decorator';
import { currentUserFactory } from './current-user.decorator';
import { Roles, ROLES_KEY } from './roles.decorator';

function contextFor(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const user = {
  id: 'u1',
  tenantId: 'shop-a',
  role: 'owner' as const,
  sessionId: 's1',
};

describe('@CurrentUser()', () => {
  it('returns the user set by the JWT strategy', () => {
    expect(currentUserFactory(undefined, contextFor({ user }))).toBe(user);
  });

  it('throws 401 when there is no user', () => {
    expect(() => currentUserFactory(undefined, contextFor({}))).toThrow(
      UnauthorizedException,
    );
  });
});

describe('@CurrentTenant()', () => {
  it('returns the tenantId from the token', () => {
    expect(currentTenantFactory(undefined, contextFor({ user }))).toBe(
      'shop-a',
    );
  });

  it('ignores tenant_id sent in the body, params or query', () => {
    const request = {
      user,
      body: { tenant_id: 'shop-b', tenantId: 'shop-b' },
      params: { tenantId: 'shop-b' },
      query: { tenantId: 'shop-b' },
    };

    expect(currentTenantFactory(undefined, contextFor(request))).toBe('shop-a');
  });

  it('throws 403 when the token has no tenant', () => {
    expect(() =>
      currentTenantFactory(
        undefined,
        contextFor({ user: { ...user, tenantId: null } }),
      ),
    ).toThrow(ForbiddenException);
  });
});

describe('@Roles()', () => {
  it('stores the roles as metadata', () => {
    const handler = () => undefined;
    Roles('owner', 'manager')({}, 'handler', { value: handler });

    expect(new Reflector().get<string[]>(ROLES_KEY, handler)).toEqual([
      'owner',
      'manager',
    ]);
  });
});
