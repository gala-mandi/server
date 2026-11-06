import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { StripTenantIdMiddleware } from './common/middleware/strip-tenant-id.middleware';
import { type Env, validateEnv } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CommoditiesModule } from './modules/commodities/commodities.module';
import { HealthModule } from './modules/health/health.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PurchasesModule } from './modules/purchases/purchases.module';
import { SalesModule } from './modules/sales/sales.module';
import { RatesModule } from './modules/rates/rates.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SettingsModule } from './modules/settings/settings.module';
import { StaffModule } from './modules/staff/staff.module';
import { StatsModule } from './modules/stats/stats.module';
import { SubscriptionGuard } from './modules/subscriptions/subscription.guard';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { TradersModule } from './modules/traders/traders.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        setup: (cls, req: Request) => {
          cls.set('ip', req.ip);
          cls.set('userAgent', req.headers['user-agent']);
        },
      },
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
          ],
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        throttlers: [
          {
            ttl: config.get('THROTTLE_TTL_MS'),
            limit: config.get('THROTTLE_LIMIT'),
          },
        ],
        errorMessage: 'Too many requests, please try again later',
      }),
    }),
    // Daily subscription check (expiry, reminders).
    ScheduleModule.forRoot(),
    DatabaseModule,
    HealthModule,
    AuthModule,
    UsersModule,
    AuditModule,
    TenantsModule,
    StaffModule,
    SettingsModule,
    TradersModule,
    CommoditiesModule,
    RatesModule,
    LedgerModule,
    StatsModule,
    PurchasesModule,
    SalesModule,
    PaymentsModule,
    ReportsModule,
    SubscriptionsModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Order matters: rate limit, then who you are, then what you may do.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Then the shop's plan: writes refused once it is read-only.
    { provide: APP_GUARD, useExisting: SubscriptionGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // A client never chooses the shop: drop any tenant_id from every body.
    consumer.apply(StripTenantIdMiddleware).forRoutes('{*splat}');
  }
}
