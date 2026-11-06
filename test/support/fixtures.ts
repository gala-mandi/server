import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { argon2Options } from '../../src/modules/auth/password.service';
import { eq, inArray, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { addDays, karachiDate } from '../../src/common/time/karachi-date';
import * as schema from '../../src/database/schema';
import {
  auditLogs,
  authLogs,
  commodities,
  dailyRates,
  invitations,
  ledgerDailyBalances,
  ledgerEntries,
  numberSequences,
  otpCodes,
  paymentAllocations,
  payments,
  plans,
  purchaseCharges,
  purchaseItems,
  purchases,
  refreshTokens,
  saleCharges,
  saleItems,
  sales,
  tenantSettings,
  tenantSubscriptions,
  tenants,
  traders,
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
  private readonly planIds: string[] = [];
  private testPlan?: Promise<string>;
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
    // Like a shop made through the API, it has a running plan; the test plan
    // has room for every user a test adds.
    await this.subscription(row.id, { planId: await this.roomyPlan() });
    return row.id;
  }

  /** A plan for this run, removed in `cleanup()`. */
  async plan(
    values: Partial<typeof plans.$inferInsert> = {},
  ): Promise<typeof plans.$inferSelect> {
    this.counter += 1;
    const [row] = await this.db
      .insert(plans)
      .values({
        name: `Test plan ${this.run}-${this.counter}`,
        maxUsers: 100,
        priceMonthly: '0.00',
        ...values,
      })
      .returning();
    this.planIds.push(row.id);
    return row;
  }

  /** A plan with room for 100 users, shared by this run's shops. */
  private roomyPlan(): Promise<string> {
    this.testPlan ??= this.plan().then((p) => p.id);
    return this.testPlan;
  }

  /**
   * Gives a shop a subscription (default: 14 days from today, Pakistan date,
   * on this run's roomy plan). Pass dates in the past to test grace and
   * read-only mode.
   */
  async subscription(
    tenantId: string,
    values: Partial<typeof tenantSubscriptions.$inferInsert> = {},
  ): Promise<typeof tenantSubscriptions.$inferSelect> {
    const today = karachiDate();
    const [row] = await this.db
      .insert(tenantSubscriptions)
      .values({
        tenantId,
        planId: values.planId ?? (await this.roomyPlan()),
        startsOn: addDays(today, -30),
        endsOn: addDays(today, 14),
        status: 'active',
        ...values,
      })
      .returning();
    return row;
  }

  /** Removes a shop's subscriptions (e.g. before giving it a new one). */
  async clearSubscriptions(tenantId: string): Promise<void> {
    await this.db
      .delete(tenantSubscriptions)
      .where(eq(tenantSubscriptions.tenantId, tenantId));
  }

  /** A plan created through the API: removed in `cleanup()`. */
  trackPlan(id: string): void {
    if (!this.planIds.includes(id)) this.planIds.push(id);
  }

  async user(
    role: Role,
    tenantId: string | null,
    extra: Partial<typeof users.$inferInsert> = {},
  ) {
    this.passwordHash ??= argon2.hash(PASSWORD, argon2Options());
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
      // Users the API created inside tracked shops (e.g. a new shop's owner,
      // or staff who accepted an invite).
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
      // Invites of tracked shops, or sent by tracked users.
      await this.db
        .delete(invitations)
        .where(
          or(
            inArray(invitations.tenantId, tIds),
            inArray(invitations.invitedBy, ids),
          ),
        );
      // Payments, sales, purchases, khata, traders, rates, commodities and
      // bill numbers of tracked shops (before their users and shops).
      await this.db
        .delete(paymentAllocations)
        .where(inArray(paymentAllocations.tenantId, tIds));
      await this.db.delete(payments).where(inArray(payments.tenantId, tIds));
      await this.db
        .delete(saleCharges)
        .where(inArray(saleCharges.tenantId, tIds));
      await this.db.delete(saleItems).where(inArray(saleItems.tenantId, tIds));
      await this.db.delete(sales).where(inArray(sales.tenantId, tIds));
      await this.db
        .delete(purchaseCharges)
        .where(inArray(purchaseCharges.tenantId, tIds));
      await this.db
        .delete(purchaseItems)
        .where(inArray(purchaseItems.tenantId, tIds));
      await this.db.delete(purchases).where(inArray(purchases.tenantId, tIds));
      await this.db
        .delete(ledgerEntries)
        .where(inArray(ledgerEntries.tenantId, tIds));
      await this.db
        .delete(ledgerDailyBalances)
        .where(inArray(ledgerDailyBalances.tenantId, tIds));
      await this.db.delete(traders).where(inArray(traders.tenantId, tIds));
      await this.db
        .delete(dailyRates)
        .where(inArray(dailyRates.tenantId, tIds));
      await this.db
        .delete(commodities)
        .where(inArray(commodities.tenantId, tIds));
      await this.db
        .delete(numberSequences)
        .where(inArray(numberSequences.tenantId, tIds));
      await this.db.delete(otpCodes).where(inArray(otpCodes.userId, ids));
      await this.db
        .delete(refreshTokens)
        .where(inArray(refreshTokens.userId, ids));
      await this.db.delete(users).where(inArray(users.id, ids));
      await this.db
        .delete(tenantSettings)
        .where(inArray(tenantSettings.tenantId, tIds));
      await this.db
        .delete(tenantSubscriptions)
        .where(inArray(tenantSubscriptions.tenantId, tIds));
      await this.db.delete(tenants).where(inArray(tenants.id, tIds));
    }
    if (this.planIds.length) {
      await this.db
        .delete(tenantSubscriptions)
        .where(inArray(tenantSubscriptions.planId, this.planIds));
      await this.db
        .delete(auditLogs)
        .where(inArray(auditLogs.entityId, this.planIds));
      await this.db.delete(plans).where(inArray(plans.id, this.planIds));
    }
    await this.pool.end();
  }
}
