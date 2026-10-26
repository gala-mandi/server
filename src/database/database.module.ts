import {
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Env } from '../config/env.schema';
import * as schema from './schema';
import { TenantDatabase } from './tenant-database';

import { type Database, DRIZZLE, PG_POOL } from './database.tokens';

export { type Database, DRIZZLE, PG_POOL } from './database.tokens';

@Injectable()
class PoolShutdown implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Pool({ connectionString: config.get('DATABASE_URL') }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Database => drizzle(pool, { schema }),
    },
    PoolShutdown,
    TenantDatabase,
  ],
  exports: [DRIZZLE, TenantDatabase],
})
export class DatabaseModule {}
