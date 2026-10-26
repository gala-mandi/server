import { Module } from '@nestjs/common';
import { UserRolesService } from './user-roles.service';

@Module({
  providers: [UserRolesService],
  exports: [UserRolesService],
})
export class UsersModule {}
