import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AccessTokenPayload, AuthUser } from '../../common/auth/auth-user';
import type { Env } from '../../config/env.schema';
import { AuthUsersService } from './auth-users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService<Env, true>,
    private readonly usersService: AuthUsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get('JWT_ACCESS_SECRET', { infer: true }),
      // Only HS256: rejects `alg: none` and algorithm-swap tokens.
      algorithms: ['HS256'],
      ignoreExpiration: false,
    });
  }

  /** Runs after the signature and expiry are checked. */
  async validate(payload: AccessTokenPayload): Promise<AuthUser> {
    const found = await this.usersService.findById(payload.sub);
    if (!found || found.user.tenantId !== payload.tenantId) {
      throw new UnauthorizedException();
    }
    // Disabled users and suspended shops lose access right away.
    this.usersService.assertCanSignIn(found);

    return {
      id: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
      sessionId: payload.sid,
    };
  }
}
