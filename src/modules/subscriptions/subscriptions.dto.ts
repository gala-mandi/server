import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isCalendarDate } from '../../common/time/karachi-date';
import { SUBSCRIPTION_STATUSES } from '../../database/schema';
import { ACCESS_STATES } from './access-state';

const date = z
  .string('Enter the date as YYYY-MM-DD')
  .trim()
  .refine(isCalendarDate, 'Enter the date as YYYY-MM-DD');

export const assignSubscriptionSchema = z
  .object({
    planId: z.uuid('Pick a plan'),
    /** Defaults to today (Pakistan date). */
    startsOn: date.optional(),
    endsOn: date,
    graceDays: z.coerce
      .number()
      .int('Enter a whole number of days')
      .min(0, 'Use 0 or more days')
      .max(90, 'Use at most 90 days')
      .default(7),
  })
  .refine((v) => !v.startsOn || v.endsOn >= v.startsOn, {
    path: ['endsOn'],
    message: 'The end date must be on or after the start date',
  });

export const extendSubscriptionSchema = z.object({ endsOn: date });

export type AssignSubscriptionInput = z.infer<typeof assignSubscriptionSchema>;
export type ExtendSubscriptionInput = z.infer<typeof extendSubscriptionSchema>;

const accessState = z.enum(ACCESS_STATES);

export const subscriptionViewSchema = z.object({
  id: z.uuid(),
  plan: z.object({
    id: z.uuid(),
    name: z.string(),
    maxUsers: z.number().int(),
    maxBranches: z.number().int(),
    priceMonthly: z.string(),
  }),
  startsOn: z.string().describe('YYYY-MM-DD'),
  endsOn: z.string().describe('YYYY-MM-DD, last day with full access'),
  graceDays: z.number().int(),
  graceEndsOn: z
    .string()
    .describe('YYYY-MM-DD, last day before read-only mode'),
  status: z.enum(SUBSCRIPTION_STATUSES),
  state: accessState.describe('active | grace | read_only (worked out today)'),
  daysLeft: z.number().int().describe('Days until endsOn (0 on the last day)'),
  graceDaysLeft: z.number().int(),
  /** Active users plus pending invites. */
  usersUsed: z.number().int(),
});

export const shopSubscriptionSchema = z.object({
  /** Today in Pakistan, the date the state is worked out for. */
  today: z.string(),
  state: accessState,
  subscription: subscriptionViewSchema.nullable(),
});

export const subscriptionBriefSchema = z.object({
  planName: z.string(),
  endsOn: z.string(),
  state: accessState,
  daysLeft: z.number().int(),
});

export type SubscriptionView = z.infer<typeof subscriptionViewSchema>;
export type ShopSubscription = z.infer<typeof shopSubscriptionSchema>;
export type SubscriptionBrief = z.infer<typeof subscriptionBriefSchema>;

export class AssignSubscriptionDto extends createZodDto(
  assignSubscriptionSchema,
) {}
export class ExtendSubscriptionDto extends createZodDto(
  extendSubscriptionSchema,
) {}
export class SubscriptionViewDto extends createZodDto(subscriptionViewSchema) {}
export class ShopSubscriptionDto extends createZodDto(shopSubscriptionSchema) {}
