import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  invalidCredentials,
  sessionExpired,
} from '../../common/auth/auth-errors';
import type { AuthUser } from '../../common/auth/auth-user';
import { permissionsFor } from '../../common/auth/permissions';
import { DRIZZLE, type Database } from '../../database/database.module';
import { users } from '../../database/schema';
import { AuthLogService } from './auth-log.service';
import { AuthUsersService, type UserWithTenant } from './auth-users.service';
import type {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  ResetPasswordDto,
} from './dto/auth-requests.dto';
import type { UserDto } from './dto/session.dto';
import { normalizePhone, parseIdentifier } from './identifier';
import {
  invalidOtp,
  OTP_RESEND_SECONDS,
  OTP_TTL_SECONDS,
  PasswordResetService,
} from './password-reset.service';
import { PasswordService } from './password.service';
import type { RequestMeta } from './request-meta';
import { isPersistent, TokensService } from './tokens.service';

export interface SessionResult {
  accessToken: string;
  expiresIn: number;
  user: UserDto;
  refreshToken: string;
  persistent: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly usersService: AuthUsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokensService,
    private readonly authLog: AuthLogService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  async login(dto: LoginDto, meta: RequestMeta): Promise<SessionResult> {
    const found = await this.usersService.findByIdentifier(
      parseIdentifier(dto.identifier),
    );
    // Same work and same answer whether or not the user exists.
    const valid = await this.passwords.verify(
      found?.user.passwordHash ?? null,
      dto.password,
    );
    if (!found || !valid) {
      await this.authLog.write({
        action: 'failed',
        userId: found?.user.id,
        tenantId: found?.user.tenantId,
        meta,
      });
      throw invalidCredentials();
    }

    await this.assertCanSignIn(found, meta);

    const issued = await this.tokens.startSession(
      found.user,
      meta,
      dto.rememberMe,
    );
    await this.db
      .update(users)
      .set({ lastLoginAt: sql`now()` })
      .where(eq(users.id, found.user.id));
    await this.authLog.write({
      action: 'login',
      userId: found.user.id,
      tenantId: found.user.tenantId,
      meta,
    });

    return this.toSession(found, issued);
  }

  /** Rotates the refresh token. Reusing an old one ends every session. */
  async refresh(
    refreshToken: string | undefined,
    meta: RequestMeta,
  ): Promise<SessionResult> {
    if (!refreshToken) throw sessionExpired();

    const stored = await this.tokens.findRefreshToken(refreshToken);
    if (!stored) throw sessionExpired();

    if (stored.revokedAt) {
      if (await this.tokens.wasRotated(stored)) {
        await this.revokeAfterReuse(stored.userId, meta);
      }
      throw sessionExpired();
    }
    if (!(await this.tokens.revokeOne(stored.id))) {
      // Another request rotated it a moment ago: same token used twice.
      await this.revokeAfterReuse(stored.userId, meta);
      throw sessionExpired();
    }
    if (stored.expiresAt.getTime() <= Date.now()) throw sessionExpired();

    const found = await this.usersService.findById(stored.userId);
    if (!found) throw sessionExpired();
    await this.assertCanSignIn(found, meta);

    const issued = await this.tokens.issue(
      found.user,
      stored.familyId,
      meta,
      isPersistent(refreshToken),
    );
    await this.authLog.write({
      action: 'refresh',
      userId: found.user.id,
      tenantId: found.user.tenantId,
      meta,
    });
    return this.toSession(found, issued);
  }

  /** A rotated refresh token came back: end every session of the user. */
  private async revokeAfterReuse(
    userId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.tokens.revokeAllForUser(userId);
    const found = await this.usersService.findById(userId);
    await this.authLog.write({
      action: 'logout',
      userId,
      tenantId: found?.user.tenantId,
      meta,
    });
  }

  async logout(
    refreshToken: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    if (!refreshToken) return;
    const stored = await this.tokens.findRefreshToken(refreshToken);
    if (!stored) return;

    await this.tokens.revokeOne(stored.id);
    const found = await this.usersService.findById(stored.userId);
    await this.authLog.write({
      action: 'logout',
      userId: stored.userId,
      tenantId: found?.user.tenantId,
      meta,
    });
  }

  async logoutAll(user: AuthUser, meta: RequestMeta): Promise<void> {
    await this.tokens.revokeAllForUser(user.id);
    await this.authLog.write({
      action: 'logout',
      userId: user.id,
      tenantId: user.tenantId,
      meta,
    });
  }

  async me(user: AuthUser): Promise<UserDto> {
    const found = await this.usersService.findById(user.id);
    if (!found) throw new NotFoundException('User not found');
    // Role and permissions as the guards see them: from the access token, so a
    // role change shows here at the same time it takes effect (next refresh).
    return {
      ...this.usersService.toDto(found),
      role: user.role,
      permissions: [...permissionsFor(user.role)],
    };
  }

  /** Keeps the current session; ends all others. */
  async changePassword(
    user: AuthUser,
    dto: ChangePasswordDto,
  ): Promise<{ revokedSessions: number }> {
    const found = await this.usersService.findById(user.id);
    if (!found) throw new NotFoundException('User not found');

    const valid = await this.passwords.verify(
      found.user.passwordHash,
      dto.currentPassword,
    );
    if (!valid) {
      throw new BadRequestException({
        message: 'Current password is incorrect',
        errors: [
          {
            field: 'currentPassword',
            message: 'Current password is incorrect',
          },
        ],
      });
    }

    await this.setPassword(user.id, dto.newPassword);
    const revokedSessions = await this.tokens.revokeAllForUser(
      user.id,
      user.sessionId,
    );
    return { revokedSessions };
  }

  /** Always answers the same, so nobody can learn which phones exist. */
  async forgotPassword(dto: ForgotPasswordDto) {
    const found = await this.usersService.findByIdentifier({
      kind: 'phone',
      value: normalizePhone(dto.phone),
    });
    if (found && this.canSignIn(found)) {
      await this.passwordReset.sendCode(found.user, dto.channel);
    }
    return {
      message: 'If this number has an account, we sent a 6-digit code to it',
      expiresIn: OTP_TTL_SECONDS,
      resendIn: OTP_RESEND_SECONDS,
    };
  }

  /** Ends every session after the password changes. */
  async resetPassword(
    dto: ResetPasswordDto,
    meta: RequestMeta,
  ): Promise<{ revokedSessions: number }> {
    const found = await this.usersService.findByIdentifier({
      kind: 'phone',
      value: normalizePhone(dto.phone),
    });
    if (!found) throw invalidOtp();

    await this.passwordReset.consumeCode(found.user.id, dto.code);
    await this.setPassword(found.user.id, dto.newPassword);
    const revokedSessions = await this.tokens.revokeAllForUser(found.user.id);
    await this.authLog.write({
      action: 'reset',
      userId: found.user.id,
      tenantId: found.user.tenantId,
      meta,
    });
    return { revokedSessions };
  }

  private async setPassword(userId: string, password: string): Promise<void> {
    await this.db
      .update(users)
      .set({
        passwordHash: await this.passwords.hash(password),
        mustChangePassword: false,
      })
      .where(eq(users.id, userId));
  }

  private canSignIn(found: UserWithTenant): boolean {
    try {
      this.usersService.assertCanSignIn(found);
      return true;
    } catch {
      return false;
    }
  }

  private async assertCanSignIn(
    found: UserWithTenant,
    meta: RequestMeta,
  ): Promise<void> {
    try {
      this.usersService.assertCanSignIn(found);
    } catch (error) {
      await this.authLog.write({
        action: 'failed',
        userId: found.user.id,
        tenantId: found.user.tenantId,
        meta,
      });
      throw error;
    }
  }

  private toSession(
    found: UserWithTenant,
    issued: { accessToken: string; refreshToken: string; persistent: boolean },
  ): SessionResult {
    return {
      accessToken: issued.accessToken,
      expiresIn: this.tokens.accessTtlSeconds,
      user: this.usersService.toDto(found),
      refreshToken: issued.refreshToken,
      persistent: issued.persistent,
    };
  }
}
