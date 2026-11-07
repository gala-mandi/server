import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { AcceptInviteService } from './accept-invite.service';
import { AuthController } from './auth.controller';
import type { AuthService, SessionResult } from './auth.service';
import type { LoginDto } from './dto/auth-requests.dto';

const session: SessionResult = {
  accessToken: 'access',
  expiresIn: 900,
  user: {} as SessionResult['user'],
  refreshToken: 'refresh.p',
  persistent: true,
};

function makeReq(
  headers: Record<string, string> = {},
  body?: unknown,
): Request {
  return { headers, body, ip: '127.0.0.1' } as unknown as Request;
}

function makeRes() {
  const cookie = jest.fn();
  const clearCookie = jest.fn();
  const res = { cookie, clearCookie } as unknown as Response;
  return { res, cookie, clearCookie };
}

describe('AuthController (web vs mobile mode)', () => {
  const auth = {
    login: jest.fn().mockResolvedValue(session),
    refresh: jest.fn().mockResolvedValue(session),
    logout: jest.fn().mockResolvedValue(undefined),
    logoutAll: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: (key: string) =>
      ({
        NODE_ENV: 'test',
        COOKIE_DOMAIN: undefined,
        REFRESH_TOKEN_TTL_DAYS: 7,
      })[key],
  } as unknown as ConfigService;
  const controller = new AuthController(
    auth as unknown as AuthService,
    {} as AcceptInviteService,
    config as never,
  );
  const mobile = { 'x-client': 'mobile' };
  const dto = { identifier: '03001234567', password: 'x' } as LoginDto;

  beforeEach(() => jest.clearAllMocks());

  it('web login sets the cookie and keeps the token out of the body', async () => {
    const { res, cookie } = makeRes();

    const body = await controller.login(dto, makeReq(), res);

    expect(cookie).toHaveBeenCalledWith(
      'refresh_token',
      'refresh.p',
      expect.objectContaining({ httpOnly: true }),
    );
    expect(body).not.toHaveProperty('refreshToken');
  });

  it('mobile login returns the token in the body and sets no cookie', async () => {
    const { res, cookie } = makeRes();

    const body = await controller.login(dto, makeReq(mobile), res);

    expect(body).toMatchObject({
      accessToken: 'access',
      refreshToken: 'refresh.p',
    });
    expect(cookie).not.toHaveBeenCalled();
  });

  it('web refresh reads the cookie and ignores a token in the body', async () => {
    const { res } = makeRes();

    await controller.refresh(
      makeReq(
        { cookie: 'refresh_token=from-cookie' },
        { refreshToken: 'body' },
      ),
      res,
    );

    expect(auth.refresh).toHaveBeenCalledWith('from-cookie', expect.anything());
  });

  it('mobile refresh reads the body and ignores the cookie', async () => {
    const { res, cookie } = makeRes();

    const body = await controller.refresh(
      makeReq(
        { ...mobile, cookie: 'refresh_token=from-cookie' },
        { refreshToken: 'from-body' },
      ),
      res,
    );

    expect(auth.refresh).toHaveBeenCalledWith('from-body', expect.anything());
    expect(body).toHaveProperty('refreshToken', 'refresh.p');
    expect(cookie).not.toHaveBeenCalled();
  });

  it('a failed web refresh clears the cookie; a failed mobile refresh sets none', async () => {
    auth.refresh.mockRejectedValue(new Error('expired'));
    const web = makeRes();
    const mob = makeRes();

    await expect(controller.refresh(makeReq(), web.res)).rejects.toThrow();
    await expect(
      controller.refresh(makeReq(mobile, { refreshToken: 't' }), mob.res),
    ).rejects.toThrow();

    expect(web.clearCookie).toHaveBeenCalled();
    expect(mob.clearCookie).not.toHaveBeenCalled();
    auth.refresh.mockResolvedValue(session);
  });

  it('mobile logout revokes the body token and touches no cookie', async () => {
    const { res, clearCookie } = makeRes();

    await controller.logout(
      makeReq(mobile, { refreshToken: 'from-body' }),
      res,
    );

    expect(auth.logout).toHaveBeenCalledWith('from-body', expect.anything());
    expect(clearCookie).not.toHaveBeenCalled();
  });

  it('web logout revokes the cookie token and clears the cookie', async () => {
    const { res, clearCookie } = makeRes();

    await controller.logout(makeReq({ cookie: 'refresh_token=c' }), res);

    expect(auth.logout).toHaveBeenCalledWith('c', expect.anything());
    expect(clearCookie).toHaveBeenCalled();
  });
});
