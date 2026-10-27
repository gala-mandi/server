import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { inArray, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../../src/database/schema';
import {
  auditLogs,
  authLogs,
  otpCodes,
  refreshTokens,
  tenantSettings,
  tenants,
  users,
} from '../../src/database/schema';

type Role = (typeof schema.userRole.enumValues)[number];
type TenantStatus = (typeof schema.tenantStatus.enumValues)[number];

export const PASSWORD = 'Correct-horse-1';

/** Creates rows with unique phones per run and removes them afterwards. */
export class Fixtures {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  readonly db = drizzle(this.pool, { schema });
  private readonly run = randomBytes(3).toString('hex');
  private counter = 0;
  private readonly tenantIds: string[] = [];
  private readonly userIds: string[] = [];
  private passwordHash?: Promise<string>;

  /** 11-digit phone, unique for this run. */
  phone(): string {
    this.counter += 1;
    const digits = `${parseInt(this.run, 16)}${this.counter}`.slice(-7);
    return `0399${digits.padStart(7, '0')}`;
  }

  async tenant(status: TenantStatus = 'active'): Promise<string> {
    const [row] = await this.db
      .insert(tenants)
      .values({
        name: `Test Shop ${this.run}-${this.counter}`,
        slug: `test-${this.run}-${(this.counter += 1)}`,
        ownerName: 'Test Owner',
        phone: this.phone(),
        status,
      })
      .returning({ id: tenants.id });
    this.tenantIds.push(row.id);
    return row.id;
  }

  async user(
    role: Role,
    tenantId: string | null,
    extra: Partial<typeof users.$inferInsert> = {},
  ) {
    this.passwordHash ??= argon2.hash(PASSWORD);
    const phone = this.phone();
    const [row] = await this.db
      .insert(users)
      .values({
        tenantId,
        name: `Test ${role}`,
        phone,
        email: `${role}-${this.run}-${this.counter}@test.local`,
        passwordHash: await this.passwordHash,
        role,
        ...extra,
      })
      .returning();
    this.userIds.push(row.id);
    return row;
  }

  /**
   * A shop created through the API: removed in `cleanup()` together with its
   * users, settings, tokens and logs.
   */
  trackTenant(id: string): void {
    if (!this.tenantIds.includes(id)) this.tenantIds.push(id);
  }

  async cleanup(): Promise<void> {
    if (this.tenantIds.length) {
      // Users the API created inside tracked shops (e.g. a new shop's owner).
      const shopUsers = await this.db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.tenantId, this.tenantIds));
      for (const { id } of shopUsers) {
        if (!this.userIds.includes(id)) this.userIds.push(id);
      }
    }
    if (this.userIds.length || this.tenantIds.length) {
      const ids = this.userIds.length
        ? this.userIds
        : ['00000000-0000-0000-0000-000000000000'];
      const tIds = this.tenantIds.length
        ? this.tenantIds
        : ['00000000-0000-0000-0000-000000000000'];
      await this.db
        .delete(authLogs)
        .where(
          or(inArray(authLogs.userId, ids), inArray(authLogs.tenantId, tIds)),
        );
      await this.db
        .delete(auditLogs)
        .where(
          or(inArray(auditLogs.userId, ids), inArray(auditLogs.tenantId, tIds)),
        );
      await this.db.delete(otpCodes).where(inArray(otpCodes.userId, ids));
      await this.db
        .delete(refreshTokens)
        .where(inArray(refreshTokens.userId, ids));
      await this.db.delete(users).where(inArray(users.id, ids));
      await this.db
        .delete(tenantSettings)
        .where(inArray(tenantSettings.tenantId, tIds));
      await this.db.delete(tenants).where(inArray(tenants.id, tIds));
    }
    await this.pool.end();
  }
}
