import { createHash, randomBytes } from 'node:crypto';

export const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

/** A random token for the link; only its hash is stored. */
export function createInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function inviteExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + INVITE_TTL_MS);
}

export type InvitationStatus = 'pending' | 'accepted' | 'cancelled' | 'expired';

export function invitationStatus(
  invitation: {
    acceptedAt: Date | null;
    cancelledAt: Date | null;
    expiresAt: Date;
  },
  now = new Date(),
): InvitationStatus {
  if (invitation.acceptedAt) return 'accepted';
  if (invitation.cancelledAt) return 'cancelled';
  if (invitation.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}
