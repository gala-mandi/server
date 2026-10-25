import { z } from 'zod';

const commaSeparatedUrls = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url()).min(1));

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  CORS_ORIGINS: commaSeparatedUrls,
  THROTTLE_TTL_MS: z.coerce.number().int().positive().default(60_000),
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(100),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Used by ConfigModule at startup. Throws one error that lists every
 * missing or wrong variable, so the app never starts half-configured.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (result.success) return result.data;

  const lines = result.error.issues.map(
    (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  throw new Error(
    `Invalid environment variables:\n${lines.join('\n')}\nCheck your .env file against .env.example.`,
  );
}
