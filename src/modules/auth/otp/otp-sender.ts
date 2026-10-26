import { Logger } from '@nestjs/common';

export type OtpChannel = 'whatsapp' | 'sms';

export interface OtpMessage {
  phone: string;
  code: string;
  channel: OtpChannel;
  purpose: 'reset_password' | 'verify_phone';
}

/** Sends a one-time code. Swap the provider without touching the auth logic. */
export interface OtpSender {
  send(message: OtpMessage): Promise<void>;
}

export const OTP_SENDER = Symbol('OTP_SENDER');

/**
 * Placeholder until a WhatsApp/SMS provider is chosen: writes the code to the
 * log in development only. In other environments it sends nothing.
 */
export class LogOtpSender implements OtpSender {
  private readonly logger = new Logger('OtpSender');

  constructor(private readonly nodeEnv: string) {}

  send({ phone, code, channel, purpose }: OtpMessage): Promise<void> {
    if (this.nodeEnv === 'development') {
      this.logger.warn(
        `[dev only] ${purpose} code for ${phone} via ${channel}: ${code}`,
      );
    } else {
      this.logger.warn(
        `No OTP provider configured; code for ${phone} was not sent`,
      );
    }
    return Promise.resolve();
  }
}
