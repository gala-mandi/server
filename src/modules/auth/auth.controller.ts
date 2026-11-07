import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCookieAuth,
  ApiExtraModels,
  ApiHeader,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../common/auth/auth-user';
import { AllowReadOnly } from '../../common/decorators/allow-read-only.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ALL_ROLES } from '../../common/auth/permissions';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { readCookie } from '../../common/http/cookies';
import type { Env } from '../../config/env.schema';
import { AuthThrottleGuard } from './auth-throttle.guard';
import { AcceptInviteService } from './accept-invite.service';
import { AuthService, type SessionResult } from './auth.service';
import {
  bodyRefreshToken,
  CLIENT_HEADER,
  isMobileClient,
  MOBILE_CLIENT,
} from './client-type';
import {
  AcceptInviteDto,
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  MobileRefreshDto,
  ResetPasswordDto,
} from './dto/auth-requests.dto';
import {
  AcceptedInviteDto,
  ForgotPasswordResultDto,
  MobileSessionDto,
  RevokedSessionsDto,
  SessionDto,
  UserResponseDto,
} from './dto/session.dto';
import {
  clearRefreshCookie,
  REFRESH_COOKIE,
  type RefreshCookieConfig,
  setRefreshCookie,
} from './refresh-cookie';
import { requestMeta } from './request-meta';

/** Documents the mobile mode on login, refresh and logout. */
const ClientHeader = () =>
  ApiHeader({
    name: CLIENT_HEADER,
    required: false,
    enum: [MOBILE_CLIENT],
    description:
      'Send `mobile` from the mobile app: the refresh token then travels in the JSON body instead of the httpOnly cookie.',
  });

/** Web gets SessionDto + cookie; the mobile app gets MobileSessionDto. */
const sessionResponse = (description: string) => ({
  description,
  schema: {
    oneOf: [
      { $ref: getSchemaPath(SessionDto) },
      { $ref: getSchemaPath(MobileSessionDto) },
    ],
  },
});

@ApiTags('auth')
@ApiExtraModels(SessionDto, MobileSessionDto)
// Signing in and out and passwords work in read-only mode too.
@AllowReadOnly()
@Controller('auth')
export class AuthController {
  private readonly cookie: RefreshCookieConfig;

  constructor(
    private readonly auth: AuthService,
    private readonly acceptInvites: AcceptInviteService,
    config: ConfigService<Env, true>,
  ) {
    this.cookie = {
      secure: config.get('NODE_ENV', { infer: true }) !== 'development',
      domain: config.get('COOKIE_DOMAIN', { infer: true }),
      maxAgeMs:
        config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) * 86_400_000,
    };
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthThrottleGuard)
  @ClientHeader()
  @ApiOkResponse(
    sessionResponse(
      'Web: sets the refresh cookie. Mobile: refreshToken in the body, no cookie.',
    ),
  )
  @ApiBadRequestResponse({ description: 'Field errors' })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  @ApiForbiddenResponse({ description: 'ACCOUNT_DISABLED | TENANT_SUSPENDED' })
  @ApiTooManyRequestsResponse({ description: 'Too many attempts' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto | MobileSessionDto> {
    return this.sendSession(
      req,
      res,
      await this.auth.login(dto, requestMeta(req)),
    );
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ClientHeader()
  @ApiBody({
    type: MobileRefreshDto,
    required: false,
    description: 'Mobile only; the web sends no body (cookie)',
  })
  @ApiOkResponse(
    sessionResponse(
      'Rotates the refresh token (web: cookie; mobile: refreshToken in the body)',
    ),
  )
  @ApiBadRequestResponse({ description: 'Mobile: malformed body' })
  @ApiUnauthorizedResponse({ description: 'SESSION_EXPIRED' })
  @ApiForbiddenResponse({ description: 'ACCOUNT_DISABLED | TENANT_SUSPENDED' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto | MobileSessionDto> {
    if (isMobileClient(req)) {
      const session = await this.auth.refresh(
        bodyRefreshToken(req),
        requestMeta(req),
      );
      return this.sendSession(req, res, session);
    }
    try {
      const session = await this.auth.refresh(
        readCookie(req.headers.cookie, REFRESH_COOKIE),
        requestMeta(req),
      );
      return this.sendSession(req, res, session);
    } catch (error) {
      clearRefreshCookie(res, this.cookie);
      throw error;
    }
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ClientHeader()
  @ApiBody({
    type: MobileRefreshDto,
    required: false,
    description: 'Mobile only; the web sends no body (cookie)',
  })
  @ApiNoContentResponse({
    description: 'Ends this session (web: also clears the cookie)',
  })
  @ApiBadRequestResponse({ description: 'Mobile: malformed body' })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (isMobileClient(req)) {
      await this.auth.logout(bodyRefreshToken(req), requestMeta(req));
      return;
    }
    await this.auth.logout(
      readCookie(req.headers.cookie, REFRESH_COOKIE),
      requestMeta(req),
    );
    clearRefreshCookie(res, this.cookie);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(...ALL_ROLES)
  @ApiBearerAuth()
  @ClientHeader()
  @ApiNoContentResponse({ description: 'Ends every session of the user' })
  @ApiUnauthorizedResponse()
  async logoutAll(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logoutAll(user, requestMeta(req));
    if (!isMobileClient(req)) clearRefreshCookie(res, this.cookie);
  }

  @Get('me')
  @Roles(...ALL_ROLES)
  @ApiBearerAuth()
  @ApiOkResponse({ type: UserResponseDto })
  @ApiUnauthorizedResponse()
  me(@CurrentUser() user: AuthUser): Promise<UserResponseDto> {
    return this.auth.me(user);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @Roles(...ALL_ROLES)
  @ApiBearerAuth()
  @ApiOkResponse({
    type: RevokedSessionsDto,
    description: 'Other sessions are ended; this one stays',
  })
  @ApiBadRequestResponse({ description: 'Current password is incorrect' })
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<RevokedSessionsDto> {
    return this.auth.changePassword(user, dto);
  }

  @Post('forgot-password')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(AuthThrottleGuard)
  @ApiAcceptedResponse({
    type: ForgotPasswordResultDto,
    description: 'Same answer whether or not the phone exists',
  })
  @ApiTooManyRequestsResponse({ description: 'Too many attempts' })
  forgotPassword(
    @Body() dto: ForgotPasswordDto,
  ): Promise<ForgotPasswordResultDto> {
    return this.auth.forgotPassword(dto);
  }

  @Post('reset-password')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOkResponse({
    type: RevokedSessionsDto,
    description: 'Every session is ended',
  })
  @ApiBadRequestResponse({ description: 'INVALID_OTP' })
  resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() req: Request,
  ): Promise<RevokedSessionsDto> {
    return this.auth.resetPassword(dto, requestMeta(req));
  }

  @Post('accept-invite')
  @Public()
  @UseGuards(AuthThrottleGuard)
  @ApiCreatedResponse({
    type: AcceptedInviteDto,
    description:
      "Creates the account in the inviting shop with the invite's role",
  })
  @ApiBadRequestResponse({
    description:
      'INVITE_INVALID | INVITE_USED | INVITE_CANCELLED | INVITE_EXPIRED',
  })
  @ApiConflictResponse({ description: 'PHONE_TAKEN' })
  acceptInvite(
    @Body() dto: AcceptInviteDto,
    @Req() req: Request,
  ): Promise<AcceptedInviteDto> {
    return this.acceptInvites.accept(dto, requestMeta(req));
  }

  private sendSession(
    req: Request,
    res: Response,
    session: SessionResult,
  ): SessionDto | MobileSessionDto {
    if (isMobileClient(req)) {
      // No cookie: the app keeps the token in the phone's secure storage.
      return {
        accessToken: session.accessToken,
        expiresIn: session.expiresIn,
        user: session.user,
        refreshToken: session.refreshToken,
      };
    }
    setRefreshCookie(
      res,
      session.refreshToken,
      session.persistent,
      this.cookie,
    );
    return {
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      user: session.user,
    };
  }
}
