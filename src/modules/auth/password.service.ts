import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordService {
  // Verified against when the user does not exist, so both cases take the same time.
  private readonly dummyHash = argon2.hash('galla-mandi-dummy-password');

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(hash: string | null, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash ?? (await this.dummyHash), password);
    } catch {
      return false;
    }
  }
}
