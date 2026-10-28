import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user';
import type { Env } from '../../config/env.schema';
import { invitations, tenants, users } from '../../database/schema';
import { TenantDatabase } from '../../database/tenant-database';
import { normalizePhone } from '../auth/identifier';
import { PasswordService } from '../auth/password.service';
import { temporaryPassword } from '../tenants/tenants.service';
import { INVITE_SENDER, type InviteSender } from './invite-sender';
import { isPhoneUniqueViolation, lockPhone, phoneTaken } from './phone-account';
import {
  createInviteToken,
  inviteExpiresAt,
  invitationStatus,
} from './invite-token';
import type {
  CreatedInvitation,
  CreateInvitationInput,
  Invitation,
} from './staff.dto';

type InvitationRow = typeof invitations.$inferSelect;
type Scope = Parameters<Parameters<TenantDatabase['transaction']>[0]>[0];

export function toInvitation(row: InvitationRow, now = new Date()): Invitation {
  return {
    id: row.id,
    phone: row.phone,
    role: row.role as Invitation['role'],
    status: invitationStatus(row, now),
    invitedBy: row.invitedBy,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Owner adds staff to their own shop (link or temporary password). */
@Injectable()
export class StaffService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly passwords: PasswordService,
    private readonly config: ConfigService<Env, true>,
    @Inject(INVITE_SENDER) private readonly sender: InviteSender,
  ) {}

  async invite(
    actor: AuthUser,
    input: CreateInvitationInput,
  ): Promise<CreatedInvitation> {
    const phone = normalizePhone(input.phone);
    return input.method === 'password'
      ? this.createWithPassword(phone, input.role, input.name ?? '')
      : this.sendInvite(actor, phone, input.role);
  }

  list(): Promise<{ data: Invitation[] }> {
    return this.tenantDb.transaction(async ({ tx, tenantId }) => {
      const rows = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.tenantId, tenantId))
        .orderBy(desc(invitations.createdAt))
        .limit(200);
      const now = new Date();
      return { data: rows.map((row) => toInvitation(row, now)) };
    });
  }

  /** Cancels a pending invite: its link stops working. Never deleted. */
  cancel(id: string): Promise<Invitation> {
    return this.tenantDb.transaction(async ({ tx, tenantId, audit }) => {
      const [before] = await tx
        .select()
        .from(invitations)
        .where(and(eq(invitations.id, id), eq(invitations.tenantId, tenantId)))
        .limit(1);
      if (!before) throw new NotFoundException('Invitation not found');
      if (invitationStatus(before) !== 'pending') return toInvitation(before);

      // Only a still-pending row changes, so two cancels log once.
      const [after] = await tx
        .update(invitations)
        .set({ cancelledAt: sql`now()` })
        .where(
          and(
            eq(invitations.id, id),
            isNull(invitations.acceptedAt),
            isNull(invitations.cancelledAt),
          ),
        )
        .returning();
      if (!after) return toInvitation(before);
      await audit({
        entity: 'invitations',
        entityId: id,
        action: 'update',
        before: { cancelledAt: null },
        after: { cancelledAt: after.cancelledAt },
      });
      return toInvitation(after);
    });
  }

  private sendInvite(
    actor: AuthUser,
    phone: string,
    role: 'manager' | 'operator',
  ): Promise<CreatedInvitation> {
    return this.tenantDb
      .transaction(async ({ tx, tenantId, audit }) => {
        await this.assertPhoneFree(tx, phone);

        await this.cancelPending(tx, tenantId, phone, audit);

        const { token, tokenHash } = createInviteToken();
        const [row] = await tx
          .insert(invitations)
          .values({
            tenantId,
            phone,
            role,
            tokenHash,
            invitedBy: actor.id,
            expiresAt: inviteExpiresAt(),
          })
          .returning();
        await audit({
          entity: 'invitations',
          entityId: row.id,
          action: 'create',
          after: row,
        });

        const [shop] = await tx
          .select({ name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, tenantId));
        const url = new URL(
          '/accept-invite',
          this.config.get('WEB_APP_URL', { infer: true }),
        );
        url.searchParams.set('token', token);
        return { row, url: url.toString(), shopName: shop?.name ?? '' };
      })
      .then(async ({ row, url, shopName }) => {
        // Sent after the commit, so a failed send never leaves a ghost invite.
        await this.sender.send({ phone, url, shopName, role });
        return {
          method: 'link' as const,
          invitation: toInvitation(row),
          inviteUrl: url,
        };
      });
  }

  private async createWithPassword(
    phone: string,
    role: 'manager' | 'operator',
    name: string,
  ): Promise<CreatedInvitation> {
    const password = temporaryPassword();
    const passwordHash = await this.passwords.hash(password);
    return this.tenantDb.transaction(async ({ tx, tenantId, audit }) => {
      await this.assertPhoneFree(tx, phone);
      // An open invite link for this phone would now fail; close it.
      await this.cancelPending(tx, tenantId, phone, audit);
      const [user] = await tx
        .insert(users)
        .values({
          tenantId,
          name,
          phone,
          passwordHash,
          role,
          mustChangePassword: true,
        })
        .returning()
        .catch((error: unknown) => {
          if (isPhoneUniqueViolation(error)) throw phoneTaken();
          throw error;
        });
      await audit({
        entity: 'users',
        entityId: user.id,
        action: 'create',
        after: user,
      });
      return {
        method: 'password' as const,
        user: { id: user.id, name: user.name, phone: user.phone, role },
        temporaryPassword: password,
      };
    });
  }

  /** A new invite or account for this phone closes its open invites. */
  private async cancelPending(
    tx: Scope['tx'],
    tenantId: string,
    phone: string,
    audit: Scope['audit'],
  ): Promise<void> {
    const replaced = await tx
      .update(invitations)
      .set({ cancelledAt: sql`now()` })
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          eq(invitations.phone, phone),
          isNull(invitations.acceptedAt),
          isNull(invitations.cancelledAt),
          gt(invitations.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: invitations.id, cancelledAt: invitations.cancelledAt });
    for (const { id, cancelledAt } of replaced) {
      await audit({
        entity: 'invitations',
        entityId: id,
        action: 'update',
        before: { cancelledAt: null },
        after: { cancelledAt },
      });
    }
  }

  /** One phone, one account, one shop. Locks the phone for this transaction. */
  private async assertPhoneFree(tx: Scope['tx'], phone: string): Promise<void> {
    await lockPhone(tx, phone);
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, phone))
      .limit(1);
    if (existing) throw phoneTaken();
  }
}
