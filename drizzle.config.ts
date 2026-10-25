import { defineConfig } from 'drizzle-kit';

// drizzle-kit does not read .env by itself; CI passes DATABASE_URL directly.
try {
  process.loadEnvFile();
} catch {
  // no .env file
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
});
