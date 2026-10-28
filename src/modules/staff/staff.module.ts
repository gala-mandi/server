import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { StaffMembersController } from './staff-members.controller';
import { INVITE_SENDER, LogInviteSender } from './invite-sender';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

@Module({
  imports: [AuthModule, UsersModule],
  controllers: [StaffController, StaffMembersController],
  providers: [
    StaffService,
    {
      provide: INVITE_SENDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new LogInviteSender(config.get('NODE_ENV', { infer: true })),
    },
  ],
})
export class StaffModule {}
