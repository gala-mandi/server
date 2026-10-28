import { Logger } from '@nestjs/common';

export interface InviteMessage {
  phone: string;
  url: string;
  shopName: string;
  role: 'manager' | 'operator';
}

/** Sends the invite link (SMS/WhatsApp provider still to be chosen). */
export interface InviteSender {
  send(message: InviteMessage): Promise<void>;
}

export const INVITE_SENDER = Symbol('INVITE_SENDER');

/**
 * Placeholder until a provider is chosen: logs the link in development only.
 * The owner also gets the link in the API response to share it themselves.
 */
export class LogInviteSender implements InviteSender {
  private readonly logger = new Logger('InviteSender');

  constructor(private readonly nodeEnv: string) {}

  send({ phone, url, shopName, role }: InviteMessage): Promise<void> {
    if (this.nodeEnv === 'development') {
      this.logger.warn(
        `[dev only] ${shopName} invites ${phone} as ${role}: ${url}`,
      );
    } else {
      this.logger.warn(
        `No messaging provider configured; invite for ${phone} was not sent`,
      );
    }
    return Promise.resolve();
  }
}
