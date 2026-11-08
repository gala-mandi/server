/**
 * Sends one test error to Sentry, to check a DSN and the alert e-mails.
 * Works for any of our Sentry projects (server, web, admin):
 *
 *   SENTRY_DSN=https://…@….ingest.sentry.io/… npm run sentry:test
 *
 * Uses the same settings and scrubbing as the API (src/instrument.ts).
 */
import * as Sentry from '@sentry/nestjs';
import { sentryOptions } from '../src/common/sentry/sentry-options';

async function main(): Promise<void> {
  const options = sentryOptions({
    ...process.env,
    SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT ?? 'sentry-test',
  });
  if (!options) {
    console.error('Set SENTRY_DSN to the project DSN first.');
    process.exit(1);
  }
  Sentry.init(options);
  const id = Sentry.captureException(
    new Error('Sentry test from Galla Mandi (safe to ignore)'),
  );
  const sent = await Sentry.flush(10_000);
  if (!sent) {
    console.error('Could not reach Sentry within 10 s. Check the DSN.');
    process.exit(1);
  }
  console.log(`Sent test event ${id}. It shows in Sentry > Issues shortly.`);
}

void main();
