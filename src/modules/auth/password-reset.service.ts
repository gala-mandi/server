import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { AuthErrorCode } from '../../common/auth/auth-errors';
import type { Env } from '../../config/env.schema';
import { DRIZZLE, type Database } from '../../database/database.module';
import { otpCodes } from '../../database/schema';
import { OTP_SENDER, type OtpChannel, type OtpSender } from './otp/otp-sender';

const PURPOSE = 'reset_password';
export const OTP_TTL_SECONDS = 600;
export const OTP_RESEND_SECONDS = 60;
export const OTP_MAX_ATTEMPTS = 5;

export const invalidOtp = () =>
  new BadRequestException({
    message: 'Invalid or expired code',
    code: AuthErrorCode.INVALID_OTP,
    errors: [{ field: 'code', message: 'Invalid or expired code' }],
  });

/** Creates, sends and checks password-reset codes. */
@Injectable()
export class PasswordResetService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async sendCode(
    user: { id: string; phone: string },
    channel: OtpChannel,
  ): Promise<void> {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');

    await this.db.transaction(async (tx) => {
      // Only the newest code works.
      await tx
        .update(otpCodes)
        .set({ expiresAt: sql`now()` })
        .where(
          and(
            eq(otpCodes.userId, user.id),
            eq(otpCodes.purpose, PURPOSE),
            isNull(otpCodes.usedAt),
            gt(otpCodes.expiresAt, sql`now()`),
          ),
        );
      await tx.insert(otpCodes).values({
        userId: user.id,
        purpose: PURPOSE,
        codeHash: this.hash(user.id, code),
        channel,
        expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
      });
    });

    await this.sender.send({
      phone: user.phone,
      code,
      channel,
      purpose: PURPOSE,
    });
  }

  /**
   * Checks the code and marks it used. Throws `INVALID_OTP` when it is wrong,
   * expired, already used, or tried too many times.
   */
  async consumeCode(userId: string, code: string): Promise<void> {
    const [otp] = await this.db
      .select()
      .from(otpCodes)
      .where(
        and(
          eq(otpCodes.userId, userId),
          eq(otpCodes.purpose, PURPOSE),
          isNull(otpCodes.usedAt),
          gt(otpCodes.expiresAt, sql`now()`),
        ),
      )
      .orderBy(desc(otpCodes.createdAt))
      .limit(1);

    if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) throw invalidOtp();

    if (!this.matches(otp.codeHash, this.hash(userId, code))) {
      await this.db
        .update(otpCodes)
        .set({ attempts: sql`${otpCodes.attempts} + 1` })
        .where(eq(otpCodes.id, otp.id));
      throw invalidOtp();
    }

    const used = await this.db
      .update(otpCodes)
      .set({ usedAt: sql`now()` })
      .where(and(eq(otpCodes.id, otp.id), isNull(otpCodes.usedAt)))
      .returning({ id: otpCodes.id });
    if (used.length === 0) throw invalidOtp();
  }

  private hash(userId: string, code: string): string {
    return createHmac('sha256', this.config.get('OTP_SECRET', { infer: true }))
      .update(`${userId}:${code}`)
      .digest('hex');
  }

  private matches(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
