import { Module } from '@nestjs/common';
import { AdminSubscriptionsController } from './admin-subscriptions.controller';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { SubscriptionGuard } from './subscription.guard';
import { SubscriptionJobsService } from './subscription-jobs.service';
import { SubscriptionController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

@Module({
  controllers: [
    PlansController,
    AdminSubscriptionsController,
    SubscriptionController,
  ],
  providers: [
    PlansService,
    SubscriptionsService,
    SubscriptionJobsService,
    SubscriptionGuard,
  ],
  exports: [SubscriptionsService, SubscriptionGuard, SubscriptionJobsService],
})
export class SubscriptionsModule {}
