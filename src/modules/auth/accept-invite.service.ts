import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { tenantSuspended } from '../../common/auth/auth-errors';
import { maskSensitive } from '../../database/audit/audit-diff';
import { DRIZZLE, type Database } from '../../database/database.module';
import { auditLogs, invitations, tenants, users } from '../../database/schema';
import { hashInviteToken, invitationStatus } from '../staff/invite-token';
import {
  isPhoneUniqueViolation,
  lockPhone,
  phoneTaken,
} from '../staff/phone-account';
import type { AcceptInviteDto } from './dto/auth-requests.dto';
import { PasswordService } from './password.service';
import type { RequestMeta } from './request-meta';

const inviteError = (code: string, message: string) =>
  new BadRequestException({
    message,
    code,
    errors: [{ field: 'token', message }],
  });

const INVALID = () =>
  inviteError('INVITE_INVALID', 'This invite link is not valid');
const MESSAGES = {
  accepted: () =>
    inviteError(
      'INVITE_USED',
      'This invite has already been used. Sign in instead.',
    ),
  cancelled: () =>
    inviteError(
      'INVITE_CANCELLED',
      'This invite was cancelled. Ask your shop owner for a new one.',
    ),
  expired: () =>
    inviteError(
      'INVITE_EXPIRED',
      'This invite has expired. Ask your shop owner for a new one.',
    ),
};

/**
 * Turns an invite into an account in the inviting shop, with the role from
 * the invite (never from the request). Single use, even under a race.
 */
@Injectable()
export class AcceptInviteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly passwords: PasswordService,
  ) {}

  async accept(
    dto: AcceptInviteDto,
    meta: RequestMeta,
  ): Promise<{ phone: string; shopName: string }> {
    const passwordHash = await this.passwords.hash(dto.password);

    return this.db.transaction(async (tx) => {
      // Same answer for every bad token, whatever its length.
      if (dto.token.length < 20 || dto.token.length > 200) throw INVALID();
      const [invite] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, hashInviteToken(dto.token)))
        .limit(1);
      if (!invite) throw INVALID();

      const status = invitationStatus(invite);
      if (status !== 'pending') throw MESSAGES[status]();

      const [shop] = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, invite.tenantId))
        .limit(1);
      if (
        !shop ||
        shop.deletedAt ||
        shop.status === 'suspended' ||
        shop.status === 'cancelled'
      ) {
        throw tenantSuspended();
      }

      await lockPhone(tx, invite.phone);
      // Claim the invite before the phone check: a second request racing
      // for it waits on this row, then finds nothing (INVITE_USED, not
      // PHONE_TAKEN). A taken phone below rolls the claim back.
      const [claimed] = await tx
        .update(invitations)
        .set({ acceptedAt: sql`now()` })
        .where(
          and(
            eq(invitations.id, invite.id),
            isNull(invitations.acceptedAt),
            isNull(invitations.cancelledAt),
            gt(invitations.expiresAt, sql`now()`),
          ),
        )
        .returning({ acceptedAt: invitations.acceptedAt });
      if (!claimed) throw MESSAGES.accepted();

      const [taken] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.phone, invite.phone))
        .limit(1);
      if (taken) throw phoneTaken();

      const [user] = await tx
        .insert(users)
        .values({
          tenantId: invite.tenantId,
          name: dto.name,
          phone: invite.phone,
          passwordHash,
          role: invite.role,
        })
        .returning()
        .catch((error: unknown) => {
          if (isPhoneUniqueViolation(error)) throw phoneTaken();
          throw error;
        });

      const audit = (
        entity: string,
        entityId: string,
        action: string,
        before: unknown,
        after: unknown,
      ) =>
        tx.insert(auditLogs).values({
          tenantId: invite.tenantId,
          userId: user.id,
          entity,
          entityId,
          action,
          before: before === null ? null : maskSensitive(before),
          after: after === null ? null : maskSensitive(after),
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
      await audit(
        'invitations',
        invite.id,
        'update',
        { acceptedAt: null },
        { acceptedAt: 'now' },
      );
      await audit('users', user.id, 'create', null, user);

      return { phone: user.phone, shopName: shop.name };
    });
  }
}
