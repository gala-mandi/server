import { createHash } from 'node:crypto';
import {
  createInviteToken,
  hashInviteToken,
  INVITE_TTL_MS,
  invitationStatus,
  inviteExpiresAt,
} from './invite-token';

const HOUR = 60 * 60 * 1000;

describe('invite token', () => {
  it('is a random base64url string of at least 40 characters', () => {
    const { token } = createInviteToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it('is different every time', () => {
    const tokens = new Set(
      Array.from({ length: 50 }, () => createInviteToken().token),
    );

    expect(tokens.size).toBe(50);
  });

  it('comes with its SHA-256 hex hash, never the token itself', () => {
    const { token, tokenHash } = createInviteToken();

    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(tokenHash).toBe(hashInviteToken(token));
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).not.toContain(token);
  });

  it('hashInviteToken is deterministic and tells tokens apart', () => {
    expect(hashInviteToken('abc')).toBe(hashInviteToken('abc'));
    expect(hashInviteToken('abc')).not.toBe(hashInviteToken('abd'));
  });
});

describe('inviteExpiresAt', () => {
  it('is 48 hours after the given time', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    expect(INVITE_TTL_MS).toBe(48 * HOUR);
    expect(inviteExpiresAt(now).toISOString()).toBe('2026-01-03T00:00:00.000Z');
  });

  it('defaults to 48 hours from now', () => {
    const before = Date.now();
    const at = inviteExpiresAt().getTime();
    const after = Date.now();

    expect(at).toBeGreaterThanOrEqual(before + 48 * HOUR);
    expect(at).toBeLessThanOrEqual(after + 48 * HOUR);
  });
});

describe('invitationStatus', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  const later = new Date(now.getTime() + HOUR);
  const earlier = new Date(now.getTime() - HOUR);
  const base = { acceptedAt: null, cancelledAt: null, expiresAt: later };

  it('pending before expiry', () => {
    expect(invitationStatus(base, now)).toBe('pending');
  });

  it('pending one millisecond before expiry', () => {
    expect(
      invitationStatus(
        { ...base, expiresAt: new Date(now.getTime() + 1) },
        now,
      ),
    ).toBe('pending');
  });

  it('expired exactly at the expiry time', () => {
    expect(invitationStatus({ ...base, expiresAt: now }, now)).toBe('expired');
  });

  it('expired after the expiry time', () => {
    expect(invitationStatus({ ...base, expiresAt: earlier }, now)).toBe(
      'expired',
    );
  });

  it('cancelled', () => {
    expect(invitationStatus({ ...base, cancelledAt: earlier }, now)).toBe(
      'cancelled',
    );
  });

  it('accepted', () => {
    expect(invitationStatus({ ...base, acceptedAt: earlier }, now)).toBe(
      'accepted',
    );
  });

  it('accepted wins over expired and cancelled', () => {
    expect(
      invitationStatus(
        { acceptedAt: earlier, cancelledAt: earlier, expiresAt: earlier },
        now,
      ),
    ).toBe('accepted');
  });

  it('cancelled wins over expired', () => {
    expect(
      invitationStatus(
        { acceptedAt: null, cancelledAt: earlier, expiresAt: earlier },
        now,
      ),
    ).toBe('cancelled');
  });

  it('uses the current time by default', () => {
    expect(
      invitationStatus({ ...base, expiresAt: new Date(Date.now() - 1000) }),
    ).toBe('expired');
    expect(
      invitationStatus({ ...base, expiresAt: new Date(Date.now() + HOUR) }),
    ).toBe('pending');
  });
});
