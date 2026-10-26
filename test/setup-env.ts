import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

// Loads .env for local runs; CI sets the variables directly.
// (process.loadEnvFile() does not reach Jest's sandboxed process.env.)
const envFile = join(__dirname, '..', '.env');
if (existsSync(envFile)) {
  for (const [key, value] of Object.entries(
    parseEnv(readFileSync(envFile, 'utf8')),
  )) {
    process.env[key] ??= value;
  }
}

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
// Room for the auth suite; the throttle test reads the limit from config.
process.env.THROTTLE_LIMIT = '300';
