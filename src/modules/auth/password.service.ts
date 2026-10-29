import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * argon2id cost. Defaults are argon2's (64 MiB, 3 passes). Tests set
 * ARGON2_MEMORY_KIB / ARGON2_TIME_COST lower to run fast; production refuses
 * anything under OWASP's minimum (19 MiB). Existing hashes keep the cost they
 * were made with, so verifying is unaffected.
 */
export function argon2Options(env: NodeJS.ProcessEnv = process.env): {
  type: typeof argon2.argon2id;
  memoryCost: number;
  timeCost: number;
} {
  const memoryCost = Number(env.ARGON2_MEMORY_KIB ?? 65_536);
  const timeCost = Number(env.ARGON2_TIME_COST ?? 3);
  if (env.NODE_ENV === 'production' && (memoryCost < 19_456 || timeCost < 2)) {
    throw new Error(
      'ARGON2_MEMORY_KIB must be at least 19456 and ARGON2_TIME_COST at least 2 in production',
    );
  }
  return { type: argon2.argon2id, memoryCost, timeCost };
}

@Injectable()
export class PasswordService {
  private readonly options = argon2Options();
  // Verified against when the user does not exist, so both cases take the same time.
  private readonly dummyHash = argon2.hash(
    'galla-mandi-dummy-password',
    this.options,
  );

  hash(password: string): Promise<string> {
    return argon2.hash(password, this.options);
  }

  async verify(hash: string | null, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash ?? (await this.dummyHash), password);
    } catch {
      return false;
    }
  }
}
