import { ConflictException } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/** Anything with `execute`, i.e. a Drizzle transaction. */
interface Executor {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
}

export const phoneTaken = () =>
  new ConflictException({
    message: 'This phone already has an account in a shop',
    code: 'PHONE_TAKEN',
    errors: [
      {
        field: 'phone',
        message: 'This phone already has an account in a shop',
      },
    ],
  });

/**
 * Serialises everything that may create an account for this phone (invite,
 * accept, temporary password) until the transaction ends, so two requests
 * can't both pass the "phone is free" check.
 */
export async function lockPhone(tx: Executor, phone: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`phone:${phone}`}))`,
  );
}

/** True for a unique violation on `users.phone` (Postgres 23505). */
export function isPhoneUniqueViolation(error: unknown): boolean {
  for (const e of [error, (error as { cause?: unknown })?.cause]) {
    if (typeof e !== 'object' || e === null) continue;
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (code === '23505') {
      return typeof constraint === 'string' && constraint.includes('phone');
    }
  }
  return false;
}
