import { ConflictException, ForbiddenException } from '@nestjs/common';

/** Machine-readable codes so the panels can show the right message. */
export const SubscriptionErrorCode = {
  SUBSCRIPTION_READ_ONLY: 'SUBSCRIPTION_READ_ONLY',
  PLAN_USER_LIMIT: 'PLAN_USER_LIMIT',
  PLAN_NAME_TAKEN: 'PLAN_NAME_TAKEN',
  TRIAL_PLAN_LOCKED: 'TRIAL_PLAN_LOCKED',
  TRIAL_PLAN_MISSING: 'TRIAL_PLAN_MISSING',
  PLAN_INACTIVE: 'PLAN_INACTIVE',
  NO_SUBSCRIPTION: 'NO_SUBSCRIPTION',
} as const;

export const subscriptionReadOnly = () =>
  new ForbiddenException({
    message:
      "This shop's plan has ended. You can still view and print; renew to add or change anything.",
    code: SubscriptionErrorCode.SUBSCRIPTION_READ_ONLY,
  });

export const planUserLimit = (maxUsers: number) =>
  new ForbiddenException({
    message: `Your plan allows ${maxUsers} users. Upgrade your plan to add more staff.`,
    code: SubscriptionErrorCode.PLAN_USER_LIMIT,
  });

/** Accepting an invite after the shop's plan was lowered. */
export const planUserLimitOnAccept = () =>
  new ForbiddenException({
    message:
      'This shop has reached the number of users its plan allows. Ask your shop owner to upgrade.',
    code: SubscriptionErrorCode.PLAN_USER_LIMIT,
    errors: [
      {
        field: 'token',
        message:
          'This shop has reached the number of users its plan allows. Ask your shop owner to upgrade.',
      },
    ],
  });

export const planNameTaken = () =>
  new ConflictException({
    message: 'A plan with this name already exists',
    code: SubscriptionErrorCode.PLAN_NAME_TAKEN,
    errors: [
      { field: 'name', message: 'A plan with this name already exists' },
    ],
  });

export const trialPlanLocked = () =>
  new ConflictException({
    message:
      "The Trial plan can't be renamed, deactivated or deleted: new shops start on it",
    code: SubscriptionErrorCode.TRIAL_PLAN_LOCKED,
  });

export const trialPlanMissing = () =>
  new ConflictException({
    message: 'There is no active Trial plan to start the new shop on',
    code: SubscriptionErrorCode.TRIAL_PLAN_MISSING,
  });

export const planInactive = () =>
  new ConflictException({
    message: 'This plan is not active',
    code: SubscriptionErrorCode.PLAN_INACTIVE,
    errors: [{ field: 'planId', message: 'This plan is not active' }],
  });

export const noSubscription = () =>
  new ConflictException({
    message: 'This shop has no plan to extend; assign one first',
    code: SubscriptionErrorCode.NO_SUBSCRIPTION,
  });
