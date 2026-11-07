/**
 * Load-test seed: LOAD_SHOPS shops (default 50), each with an owner,
 * LOAD_OPERATORS operators (default 5), LOAD_KISSANS kissans (default 20),
 * the default commodity list and a Trial plan — the same rows a shop made
 * through the API starts with. Safe to run again: existing rows stay.
 *
 * Phones are fixed so the k6 script can sign in without a hand-off file:
 *   owner of shop s    0398 sss 0000
 *   operator o, shop s 0398 sss 000o
 * Every user gets the password in LOAD_TEST_PASSWORD (no default).
 *
 * Refuses any database that is not on this machine unless
 * LOAD_SEED_ALLOW_REMOTE=yes: these accounts have a shared, known password.
 *
 * Usage: LOAD_TEST_PASSWORD=... npm run load:seed (reads .env)
 */
import * as argon2 from 'argon2';
import { and, count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/database/schema';
import {
  commodities,
  tenantSettings,
  tenantSubscriptions,
  tenants,
  traders,
  users,
} from '../src/database/schema';
import { argon2Options } from '../src/modules/auth/password.service';
import { defaultCommodityRows } from '../src/modules/commodities/default-commodities';
import { startTrial } from '../src/modules/subscriptions/subscription-queries';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing. See load/README.md.`);
  return value;
}

function positive(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be a whole number from 1 to ${max}`);
  }
  return value;
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** Same rule as load/purchases.js. */
export const loadPhone = (shop: number, member: number) =>
  `0398${pad(shop, 3)}${pad(member, 4)}`;

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file
  }

  const url = required('DATABASE_URL');
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && process.env.LOAD_SEED_ALLOW_REMOTE !== 'yes') {
    throw new Error(
      `Refusing to seed load-test users into ${host}. Set LOAD_SEED_ALLOW_REMOTE=yes for a test server.`,
    );
  }
  const password = required('LOAD_TEST_PASSWORD');
  const shops = positive('LOAD_SHOPS', 50, 999);
  const operators = positive('LOAD_OPERATORS', 5, 99);
  const kissans = positive('LOAD_KISSANS', 20, 9999);

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  // One hash for every load user: seeding 300 users stays fast.
  const passwordHash = await argon2.hash(password, argon2Options());

  try {
    for (let s = 1; s <= shops; s += 1) {
      const slug = `load-shop-${pad(s, 3)}`;
      const name = `Load Shop ${pad(s, 3)}`;
      await db.transaction(async (tx) => {
        const [tenant] = await tx
          .insert(tenants)
          .values({
            name,
            slug,
            ownerName: `${name} Owner`,
            phone: loadPhone(s, 0),
            city: 'Okara',
            status: 'active',
          })
          .onConflictDoUpdate({ target: tenants.slug, set: { slug } })
          .returning({ id: tenants.id });

        await tx
          .insert(tenantSettings)
          .values({ tenantId: tenant.id, displayName: name })
          .onConflictDoNothing();

        const [{ existing }] = await tx
          .select({ existing: count() })
          .from(commodities)
          .where(eq(commodities.tenantId, tenant.id));
        if (existing === 0) {
          await tx.insert(commodities).values(defaultCommodityRows(tenant.id));
        }

        const [{ plans }] = await tx
          .select({ plans: count() })
          .from(tenantSubscriptions)
          .where(eq(tenantSubscriptions.tenantId, tenant.id));
        if (plans === 0) await startTrial(tx, tenant.id);

        await tx
          .insert(users)
          .values(
            Array.from({ length: operators + 1 }, (_, member) => ({
              tenantId: tenant.id,
              name: member === 0 ? `${name} Owner` : `Operator ${member}`,
              phone: loadPhone(s, member),
              passwordHash,
              role: member === 0 ? ('owner' as const) : ('operator' as const),
            })),
          )
          .onConflictDoNothing();

        const [{ have }] = await tx
          .select({ have: count() })
          .from(traders)
          .where(
            and(eq(traders.tenantId, tenant.id), eq(traders.type, 'kissan')),
          );
        if (have < kissans) {
          await tx
            .insert(traders)
            .values(
              Array.from({ length: kissans }, (_, k) => ({
                tenantId: tenant.id,
                type: 'kissan' as const,
                name: `Kissan ${pad(k + 1, 3)}`,
                phone: `0397${pad(s, 3)}${pad(k + 1, 4)}`,
                village: 'Chak 12',
              })),
            )
            .onConflictDoNothing();
        }
      });
    }
    console.log(
      `Load seed done: ${shops} shops × ${operators} operators, ${kissans} kissans each.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
