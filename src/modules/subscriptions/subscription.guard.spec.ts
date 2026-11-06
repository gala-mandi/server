import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AllowReadOnly } from '../../common/decorators/allow-read-only.decorator';
import type { AccessState } from './access-state';
import { SubscriptionGuard } from './subscription.guard';
import type { SubscriptionsService } from './subscriptions.service';

class ShopController {
  create() {}
}
@AllowReadOnly()
class AuthLikeController {
  logout() {}
}

function contextFor(
  method: string,
  user: { tenantId: string | null } | undefined,
  controller: new () => object = ShopController,
): ExecutionContext {
  const handler = Object.getOwnPropertyNames(controller.prototype)
    .filter((n) => n !== 'constructor')
    .map((n) => (controller.prototype as Record<string, unknown>)[n])[0];
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ method, user }) }),
  } as unknown as ExecutionContext;
}

function guardWith(state: AccessState) {
  const accessState = jest.fn(() => Promise.resolve(state));
  const guard = new SubscriptionGuard(new Reflector(), {
    accessState,
  } as unknown as SubscriptionsService);
  return { guard, accessState };
}

const shopUser = { tenantId: 'shop-a' };

describe('SubscriptionGuard', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'read-only shop: %s is refused with SUBSCRIPTION_READ_ONLY',
    async (method) => {
      const { guard } = guardWith('read_only');
      await expect(
        guard.canActivate(contextFor(method, shopUser)),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'SUBSCRIPTION_READ_ONLY' },
      });
    },
  );

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'read-only shop: %s works without looking up the plan',
    async (method) => {
      const { guard, accessState } = guardWith('read_only');
      await expect(
        guard.canActivate(contextFor(method, shopUser)),
      ).resolves.toBe(true);
      expect(accessState).not.toHaveBeenCalled();
    },
  );

  it.each<AccessState>(['active', 'grace'])(
    '%s shop: writes work',
    async (state) => {
      const { guard } = guardWith(state);
      await expect(
        guard.canActivate(contextFor('POST', shopUser)),
      ).resolves.toBe(true);
    },
  );

  it('@AllowReadOnly() routes (sign in/out, password) work in read-only', async () => {
    const { guard, accessState } = guardWith('read_only');
    await expect(
      guard.canActivate(contextFor('POST', shopUser, AuthLikeController)),
    ).resolves.toBe(true);
    expect(accessState).not.toHaveBeenCalled();
  });

  it('super-admin (no shop) is never affected', async () => {
    const { guard, accessState } = guardWith('read_only');
    await expect(
      guard.canActivate(contextFor('POST', { tenantId: null })),
    ).resolves.toBe(true);
    expect(accessState).not.toHaveBeenCalled();
  });

  it('public routes (no user) are left to their own checks', async () => {
    const { guard } = guardWith('read_only');
    await expect(
      guard.canActivate(contextFor('POST', undefined)),
    ).resolves.toBe(true);
  });
});
