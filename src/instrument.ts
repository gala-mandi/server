// Loaded first by main.ts, before Nest and the HTTP modules, so Sentry can
// hook into them. Does nothing unless SENTRY_DSN is set.
import * as Sentry from '@sentry/nestjs';
import { sentryOptions } from './common/sentry/sentry-options';

// Runs before ConfigModule reads .env, so read it here too (local runs).
// Variables already set in the environment win, as with ConfigModule.
try {
  process.loadEnvFile();
} catch {
  // no .env file (production sets real environment variables)
}

const options = sentryOptions(process.env);
if (options) Sentry.init(options);
