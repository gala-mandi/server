import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Public } from '../decorators/public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

class Probe {
  @Public()
  static open() {}

  static closed() {}
}

function contextFor(handler: () => void): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Probe,
    switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  const guard = new JwtAuthGuard(new Reflector());

  it('lets @Public() routes through without a token', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(guard.canActivate(contextFor(Probe.open))).toBe(true);
  });

  it('asks passport for every other route', () => {
    const passport = jest
      .spyOn(
        Object.getPrototypeOf(JwtAuthGuard.prototype) as {
          canActivate: () => boolean;
        },
        'canActivate',
      )
      .mockReturnValue(false);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(guard.canActivate(contextFor(Probe.closed))).toBe(false);
    expect(passport).toHaveBeenCalledTimes(1);
    passport.mockRestore();
  });
});
