import { INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
  Reflector,
} from '@nestjs/core';
import { App } from 'supertest/types';
import { PERMISSIONS_KEY } from '../src/common/decorators/permissions.decorator';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { createTestApp } from './create-app';

interface Handler {
  name: string;
  access: 'public' | 'roles' | 'permissions' | null;
  permissions: string[];
}

/**
 * "Done when: every endpoint has an explicit role/permission or `@Public()`."
 * Walks every controller of the real AppModule (no test modules).
 */
describe('Route access metadata (e2e)', () => {
  let app: INestApplication<App>;
  let handlers: Handler[];

  beforeAll(async () => {
    app = await createTestApp({ imports: [DiscoveryModule] });

    const discovery = app.get(DiscoveryService);
    const scanner = app.get(MetadataScanner);
    const reflector = app.get(Reflector);

    handlers = discovery.getControllers().flatMap((wrapper) => {
      const controller = wrapper.metatype as (new () => unknown) | null;
      if (!controller) return [];
      const proto = controller.prototype as Record<string, unknown>;

      return scanner
        .getAllMethodNames(proto)
        .map((method) => proto[method])
        .filter(
          (fn): fn is (...args: unknown[]) => unknown =>
            typeof fn === 'function' &&
            Reflect.getMetadata(PATH_METADATA, fn) !== undefined &&
            Reflect.getMetadata(METHOD_METADATA, fn) !== undefined,
        )
        .map((fn) => {
          const targets = [fn, controller];
          const has = (key: string) => {
            const value = reflector.getAllAndOverride<unknown>(key, targets);
            return Array.isArray(value) ? value.length > 0 : value === true;
          };
          const access: Handler['access'] = has(IS_PUBLIC_KEY)
            ? 'public'
            : has(PERMISSIONS_KEY)
              ? 'permissions'
              : has(ROLES_KEY)
                ? 'roles'
                : null;
          const permissions =
            reflector.getAllAndOverride<string[] | undefined>(
              PERMISSIONS_KEY,
              targets,
            ) ?? [];
          return { name: `${controller.name}.${fn.name}`, access, permissions };
        });
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('finds the app routes', () => {
    const names = handlers.map((h) => h.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'AuthController.login',
        'AuthController.me',
        'HealthController.check',
        'SettingsController.get',
        'SettingsController.update',
        'SettingsController.uploadLogo',
        'TradersController.list',
        'TradersController.lookup',
        'TradersController.create',
        'TradersController.get',
        'TradersController.update',
        'TradersController.remove',
      ]),
    );
  });

  it('every route is @Public() or has @Roles()/@Permissions()', () => {
    const missing = handlers.filter((h) => !h.access).map((h) => h.name);

    expect(missing).toEqual([]);
  });

  it('the settings routes need a permission', () => {
    const settings = handlers.filter((h) =>
      h.name.startsWith('SettingsController.'),
    );

    expect(settings).toHaveLength(3);
    expect(settings.every((h) => h.access === 'permissions')).toBe(true);
  });

  it('the trader routes need their own permission', () => {
    const traders = Object.fromEntries(
      handlers
        .filter((h) => h.name.startsWith('TradersController.'))
        .map((h) => [h.name.split('.')[1], h.permissions]),
    );

    expect(traders).toEqual({
      list: ['trader.view'],
      lookup: ['trader.view'],
      get: ['trader.view'],
      create: ['trader.create'],
      update: ['trader.manage'],
      remove: ['trader.delete'],
    });
  });

  it('only the expected routes are public', () => {
    const open = handlers
      .filter((h) => h.access === 'public')
      .map((h) => h.name)
      .sort();

    expect(open).toEqual(
      [
        'AuthController.acceptInvite',
        'AuthController.forgotPassword',
        'AuthController.login',
        'AuthController.logout',
        'AuthController.refresh',
        'AuthController.resetPassword',
        'HealthController.check',
      ].sort(),
    );
  });
});
