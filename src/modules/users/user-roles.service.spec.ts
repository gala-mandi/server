import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth-user';
import type { users } from '../../database/schema';
import type { TenantDatabase } from '../../database/tenant-database';
import { toStaffMember, UserRolesService } from './user-roles.service';

type UserRow = typeof users.$inferSelect;

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';

function row(extra: Partial<UserRow> = {}): UserRow {
  return {
    id: OTHER,
    tenantId: TENANT,
    name: 'Asif',
    phone: '03001234567',
    email: 'asif@test.local',
    passwordHash: '$argon2id$secret',
    role: 'manager',
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: new Date('2026-01-02T03:04:05.678Z'),
    updatedAt: new Date('2026-01-03T00:00:00.000Z'),
    deletedAt: null,
    ...extra,
  };
}

describe('toStaffMember', () => {
  it('maps a row to the public shape, dates as ISO, no secrets', () => {
    const member = toStaffMember(
      row({ lastLoginAt: new Date('2026-02-01T10:00:00.000Z') }),
      ACTOR,
    );

    expect(member).toEqual({
      id: OTHER,
      name: 'Asif',
      phone: '03001234567',
      email: 'asif@test.local',
      role: 'manager',
      isActive: true,
      lastLoginAt: '2026-02-01T10:00:00.000Z',
      mustChangePassword: false,
      createdAt: '2026-01-02T03:04:05.678Z',
      isYou: false,
    });
    expect(JSON.stringify(member)).not.toContain('argon2');
  });

  it('lastLoginAt is null before the first login; email may be null', () => {
    const member = toStaffMember(row({ email: null }), ACTOR);

    expect(member.lastLoginAt).toBeNull();
    expect(member.email).toBeNull();
  });

  it('isYou only for the actor', () => {
    expect(toStaffMember(row({ id: ACTOR }), ACTOR).isYou).toBe(true);
    expect(toStaffMember(row(), ACTOR).isYou).toBe(false);
  });
});

describe('UserRolesService guards (before any DB work)', () => {
  const transaction = jest.fn();
  const service = new UserRolesService({
    transaction,
  } as unknown as TenantDatabase);
  const actor = (role: AuthUser['role']): AuthUser => ({
    id: ACTOR,
    tenantId: TENANT,
    role,
    sessionId: 'sid',
  });

  beforeEach(() => transaction.mockReset());

  it.each(['manager', 'operator', 'super_admin'] as const)(
    '%s may not list, change roles or (de)activate',
    async (role) => {
      await expect(service.list(actor(role))).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        service.changeRole(actor(role), OTHER, 'operator'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.setActive(actor(role), OTHER, false),
      ).rejects.toThrow(ForbiddenException);
      await expect(service.setActive(actor(role), OTHER, true)).rejects.toThrow(
        ForbiddenException,
      );
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it('an owner cannot deactivate themselves', async () => {
    const error: unknown = await service
      .setActive(actor('owner'), ACTOR, false)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'CANNOT_DEACTIVATE_SELF',
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('a shop user cannot be made a super-admin', async () => {
    await expect(
      service.changeRole(actor('owner'), OTHER, 'super_admin' as never),
    ).rejects.toThrow(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });
});
