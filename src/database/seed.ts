/**
 * Local development seed: one super-admin and one demo shop with an owner.
 * Safe to run again; existing rows are left as they are.
 * Usage: npm run db:seed (reads .env)
 */
import * as argon2 from 'argon2';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { tenants, users } from './schema';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing. See .env.example.`);
  return value;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file
  }

  const pool = new Pool({ connectionString: required('DATABASE_URL') });
  const db = drizzle(pool, { schema });

  try {
    await db
      .insert(users)
      .values({
        name: 'Platform Admin',
        phone: process.env.SEED_SUPER_ADMIN_PHONE ?? '03000000001',
        passwordHash: await argon2.hash(required('SEED_SUPER_ADMIN_PASSWORD')),
        role: 'super_admin',
      })
      .onConflictDoNothing({ target: users.phone });

    const [tenant] = await db
      .insert(tenants)
      .values({
        name: 'Demo Mandi',
        slug: 'demo-mandi',
        ownerName: 'Demo Owner',
        phone: process.env.SEED_OWNER_PHONE ?? '03000000002',
        city: 'Okara',
        status: 'active',
      })
      .onConflictDoUpdate({ target: tenants.slug, set: { slug: 'demo-mandi' } })
      .returning({ id: tenants.id });

    await db
      .insert(users)
      .values({
        tenantId: tenant.id,
        name: 'Demo Owner',
        phone: process.env.SEED_OWNER_PHONE ?? '03000000002',
        passwordHash: await argon2.hash(required('SEED_OWNER_PASSWORD')),
        role: 'owner',
      })
      .onConflictDoNothing({ target: users.phone });

    console.log('Seed done: super-admin and Demo Mandi owner are ready.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
