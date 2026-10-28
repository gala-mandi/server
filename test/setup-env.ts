import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
// Fast password hashing for tests only (production refuses these values).
process.env.ARGON2_MEMORY_KIB = '1024';
process.env.ARGON2_TIME_COST = '1';
// Logos go to a temp folder; tests never upload to ImageKit.
process.env.UPLOADS_DIR = join(tmpdir(), 'galla-mandi-test-uploads');
delete process.env.IMAGEKIT_PRIVATE_KEY;
