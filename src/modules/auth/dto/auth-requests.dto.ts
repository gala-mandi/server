import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const password = z.string().min(1, 'Password is required').max(128);
const newPassword = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'Use at most 128 characters');
const phone = z
  .string()
  .trim()
  .regex(/^[+\d][\d\s-]{6,19}$/, 'Enter a valid phone number');

export const loginSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(1, 'Phone number or email is required')
    .max(160),
  password,
  rememberMe: z.boolean().default(false),
});

export const changePasswordSchema = z.object({
  currentPassword: password,
  newPassword,
});

export const forgotPasswordSchema = z.object({
  phone,
  channel: z.enum(['whatsapp', 'sms']).default('whatsapp'),
});

export const resetPasswordSchema = z.object({
  phone,
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  newPassword,
});

export class LoginDto extends createZodDto(loginSchema) {}
export class ChangePasswordDto extends createZodDto(changePasswordSchema) {}
export class ForgotPasswordDto extends createZodDto(forgotPasswordSchema) {}
export class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}

export const acceptInviteSchema = z.object({
  // Length is checked in the service so every bad token gets INVITE_INVALID.
  token: z.string().trim().max(5000),
  name: z.string().trim().min(2, 'Enter your name').max(120),
  password: newPassword,
});

export class AcceptInviteDto extends createZodDto(acceptInviteSchema) {}
