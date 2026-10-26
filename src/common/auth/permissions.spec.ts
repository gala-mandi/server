import type { Role } from './auth-user';
import {
  ALL_ROLES,
  PERMISSIONS,
  type Permission,
  permissionsFor,
  ROLE_PERMISSIONS,
  roleHas,
} from './permissions';

const PLATFORM: Permission[] = [
  'tenant.manage',
  'plan.manage',
  'platform_report.view',
];
const DELETES = PERMISSIONS.filter((p) => p.endsWith('.delete'));

describe('permission matrix', () => {
  it('lists every role', () => {
    expect([...ALL_ROLES].sort()).toEqual(Object.keys(ROLE_PERMISSIONS).sort());
  });

  it('uses only known permissions, without duplicates', () => {
    for (const role of ALL_ROLES) {
      const list = ROLE_PERMISSIONS[role];
      expect(list.every((p) => PERMISSIONS.includes(p))).toBe(true);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('super_admin: platform only, no daily shop entries', () => {
    expect([...permissionsFor('super_admin')].sort()).toEqual(
      [...PLATFORM].sort(),
    );
    expect(roleHas('super_admin', 'purchase.create')).toBe(false);
  });

  it('owner: everything in the shop, incl. staff, settings, delete, reports', () => {
    const owner = permissionsFor('owner');
    for (const p of PERMISSIONS.filter((p) => !PLATFORM.includes(p))) {
      expect(owner).toContain(p);
    }
    expect(owner.some((p) => PLATFORM.includes(p))).toBe(false);
  });

  it('manager: daily work and reports; no staff, settings or delete', () => {
    for (const p of [
      'trader.manage',
      'rate.manage',
      'purchase.create',
      'purchase.edit',
      'sale.edit',
      'payment.edit',
      'report.view',
      'ledger.view',
    ] as Permission[]) {
      expect(roleHas('manager', p)).toBe(true);
    }
    for (const p of [
      'staff.manage',
      'settings.manage',
      ...DELETES,
    ] as Permission[]) {
      expect(roleHas('manager', p)).toBe(false);
    }
  });

  it('operator: create purchases, sales, payments and view rates only', () => {
    for (const p of [
      'purchase.create',
      'sale.create',
      'payment.create',
      'rate.view',
    ] as Permission[]) {
      expect(roleHas('operator', p)).toBe(true);
    }
    for (const p of [
      'purchase.edit',
      'sale.edit',
      'payment.edit',
      'rate.manage',
      'report.view',
      'ledger.view',
      'staff.manage',
      'settings.manage',
      ...DELETES,
    ] as Permission[]) {
      expect(roleHas('operator', p)).toBe(false);
    }
  });

  it.each<[Role, number]>([
    ['operator', 10],
    ['super_admin', 3],
  ])('%s has exactly %i permissions', (role, count) => {
    expect(permissionsFor(role)).toHaveLength(count);
  });
});
