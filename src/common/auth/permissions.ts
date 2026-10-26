import type { Role } from './auth-user';

/** Every role, e.g. for routes any signed-in user may call. */
export const ALL_ROLES: readonly Role[] = [
  'super_admin',
  'owner',
  'manager',
  'operator',
];

/** The single list of permissions. Frontends get a user's list from `/auth/me`. */
export const PERMISSIONS = [
  // Platform (super_admin only)
  'tenant.manage',
  'plan.manage',
  'platform_report.view',
  // Shop
  'dashboard.view',
  'staff.manage',
  'settings.manage',
  'trader.view',
  'trader.manage',
  'trader.delete',
  'commodity.view',
  'commodity.manage',
  'commodity.delete',
  'rate.view',
  'rate.manage',
  'purchase.view',
  'purchase.create',
  'purchase.edit',
  'purchase.delete',
  'sale.view',
  'sale.create',
  'sale.edit',
  'sale.delete',
  'payment.view',
  'payment.create',
  'payment.edit',
  'payment.delete',
  'ledger.view',
  'report.view',
  'audit.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PLATFORM: readonly Permission[] = [
  'tenant.manage',
  'plan.manage',
  'platform_report.view',
];

const SHOP: readonly Permission[] = PERMISSIONS.filter(
  (p) => !PLATFORM.includes(p),
);

/**
 * Default permission matrix.
 * - super_admin: platform only, no daily shop entries
 * - owner: everything in the shop, incl. staff, settings, delete, reports
 * - manager: daily work + reports; no staff, settings, delete or audit log
 * - operator: create purchases, sales, payments; view rates (and the traders
 *   and commodities a purchase needs); no edit, delete or reports
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: PLATFORM,
  owner: SHOP,
  manager: SHOP.filter(
    (p) =>
      p !== 'staff.manage' &&
      p !== 'settings.manage' &&
      p !== 'audit.view' &&
      !p.endsWith('.delete'),
  ),
  operator: [
    'dashboard.view',
    'rate.view',
    'trader.view',
    'commodity.view',
    'purchase.view',
    'purchase.create',
    'sale.view',
    'sale.create',
    'payment.view',
    'payment.create',
  ],
};

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
