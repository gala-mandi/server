import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { AccessTokenPayload } from '../../common/auth/auth-user';
import type { Env } from '../../config/env.schema';
import { DRIZZLE, type Database } from '../../database/database.module';
import { refreshTokens } from '../../database/schema';
import type { UserRow } from './auth-users.service';
import type { RequestMeta } from './request-meta';

export type RefreshTokenRow = typeof refreshTokens.$inferSelect;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** true = "keep me signed in": the cookie outlives the browser session. */
  persistent: boolean;
}

/** A refresh token's last part says whether its cookie is persistent. */
const PERSISTENT = 'p';
const SESSION_ONLY = 's';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isPersistent(token: string): boolean {
  return token.endsWith(`.${PERSISTENT}`);
}

@Injectable()
export class TokensService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  get accessTtlSeconds(): number {
    return this.config.get('JWT_ACCESS_TTL_SEC', { infer: true });
  }

  get refreshTtlMs(): number {
    return (
      this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) * 86_400_000
    );
  }

  signAccessToken(user: UserRow, sessionId: string): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      sid: sessionId,
    };
    return this.jwt.signAsync(payload);
  }

  /** Starts a new session (refresh-token family) for a fresh login. */
  async startSession(
    user: UserRow,
    meta: RequestMeta,
    persistent: boolean,
  ): Promise<IssuedTokens> {
    return this.issue(user, randomUUID(), meta, persistent);
  }

  async issue(
    user: UserRow,
    familyId: string,
    meta: RequestMeta,
    persistent: boolean,
  ): Promise<IssuedTokens> {
    const refreshToken = `${randomBytes(32).toString('base64url')}.${persistent ? PERSISTENT : SESSION_ONLY}`;
    await this.db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      familyId,
      deviceInfo: meta.userAgent?.slice(0, 200) ?? null,
      ip: meta.ip,
      expiresAt: new Date(Date.now() + this.refreshTtlMs),
    });
    const accessToken = await this.signAccessToken(user, familyId);
    return { accessToken, refreshToken, persistent };
  }

  async findRefreshToken(token: string): Promise<RefreshTokenRow | null> {
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(token)))
      .limit(1);
    return row ?? null;
  }

  /**
   * True when the token was replaced by a newer one in its family, i.e. it
   * was rotated. Using such a token again means it was stolen. Tokens ended
   * by logout or a password change have no successor.
   */
  async wasRotated(token: RefreshTokenRow): Promise<boolean> {
    const [successor] = await this.db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(
        // A family only grows by rotation, so any other row is a successor.
        and(
          eq(refreshTokens.familyId, token.familyId),
          ne(refreshTokens.id, token.id),
        ),
      )
      .limit(1);
    return Boolean(successor);
  }

  /**
   * Marks one token as used. Returns false if it was already revoked,
   * e.g. by a parallel request — the caller treats that as reuse.
   */
  async revokeOne(id: string): Promise<boolean> {
    const rows = await this.db
      .update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    return rows.length === 1;
  }

  /** Ends every session of the user, optionally keeping one. Returns how many ended. */
  async revokeAllForUser(
    userId: string,
    exceptFamilyId?: string,
  ): Promise<number> {
    const conditions = [
      eq(refreshTokens.userId, userId),
      isNull(refreshTokens.revokedAt),
      sql`${refreshTokens.expiresAt} > now()`,
    ];
    if (exceptFamilyId) {
      conditions.push(ne(refreshTokens.familyId, exceptFamilyId));
    }
    const rows = await this.db
      .update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(...conditions))
      .returning({ familyId: refreshTokens.familyId });
    return new Set(rows.map((row) => row.familyId)).size;
  }
}
