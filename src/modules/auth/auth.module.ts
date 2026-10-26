import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { Env } from '../../config/env.schema';
import { AuthLogService } from './auth-log.service';
import { AuthThrottleGuard } from './auth-throttle.guard';
import { AuthUsersService } from './auth-users.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { LogOtpSender, OTP_SENDER } from './otp/otp-sender';
import { PasswordResetService } from './password-reset.service';
import { PasswordService } from './password.service';
import { TokensService } from './tokens.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: config.get('JWT_ACCESS_TTL_SEC', { infer: true }),
        },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthUsersService,
    AuthLogService,
    PasswordService,
    PasswordResetService,
    TokensService,
    JwtStrategy,
    AuthThrottleGuard,
    {
      provide: OTP_SENDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new LogOtpSender(config.get('NODE_ENV', { infer: true })),
    },
  ],
  exports: [AuthUsersService],
})
export class AuthModule {}
