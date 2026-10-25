import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';

const migrationsFolder = join(__dirname, '../src/database/migrations');

function databaseUrl(name?: string): string {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (name) url.pathname = `/${name}`;
  return url.toString();
}

describe('Database (integration)', () => {
  it('connects to Postgres', async () => {
    const client = new Client({ connectionString: databaseUrl() });
    await client.connect();
    const { rows } = await client.query<{ ok: number }>('select 1 as ok');
    await client.end();

    expect(rows[0].ok).toBe(1);
  });

  describe('migrations on an empty database', () => {
    const name = `galla_mandi_migrate_${randomBytes(4).toString('hex')}`;
    let admin: Client;
    let pool: Pool;

    beforeAll(async () => {
      admin = new Client({ connectionString: databaseUrl() });
      await admin.connect();
      await admin.query(`create database "${name}"`);
      pool = new Pool({ connectionString: databaseUrl(name) });
    });

    afterAll(async () => {
      await pool.end();
      await admin.query(`drop database if exists "${name}"`);
      await admin.end();
    });

    it('creates tenants and users with the columns from schema.dbml', async () => {
      await migrate(drizzle(pool), { migrationsFolder });

      const { rows } = await pool.query<{
        table_name: string;
        column_name: string;
      }>(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'public' and table_name in ('tenants', 'users')
         order by table_name, ordinal_position`,
      );
      const columns = (table: string) =>
        rows.filter((r) => r.table_name === table).map((r) => r.column_name);

      expect(columns('tenants')).toEqual([
        'id',
        'name',
        'slug',
        'owner_name',
        'phone',
        'email',
        'address',
        'city',
        'logo_url',
        'status',
        'created_at',
        'updated_at',
        'deleted_at',
      ]);
      expect(columns('users')).toEqual([
        'id',
        'tenant_id',
        'name',
        'phone',
        'email',
        'password_hash',
        'role',
        'is_active',
        'must_change_password',
        'last_login_at',
        'created_at',
        'updated_at',
        'deleted_at',
      ]);
    });

    it('is safe to run again', async () => {
      await expect(
        migrate(drizzle(pool), { migrationsFolder }),
      ).resolves.toBeUndefined();
    });

    it('links users to tenants and fills defaults', async () => {
      const tenant = await pool.query<{ id: string; status: string }>(
        `insert into tenants (name, slug, owner_name, phone)
         values ('Demo Shop', 'demo-shop', 'Demo Owner', '03000000000')
         returning id, status`,
      );
      expect(tenant.rows[0].status).toBe('trial');

      const user = await pool.query<{ is_active: boolean }>(
        `insert into users (tenant_id, name, phone, password_hash, role)
         values ($1, 'Demo Owner', '03000000000', 'x', 'owner')
         returning is_active`,
        [tenant.rows[0].id],
      );
      expect(user.rows[0].is_active).toBe(true);

      await expect(
        pool.query(
          `insert into users (tenant_id, name, phone, password_hash, role)
           values (gen_random_uuid(), 'Ghost', '03111111111', 'x', 'owner')`,
        ),
      ).rejects.toThrow(/foreign key/);
    });
  });
});
