import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import {
  CreatedInvitationDto,
  CreateInvitationDto,
  InvitationDto,
  InvitationListDto,
} from './staff.dto';
import { StaffService } from './staff.service';

@ApiTags('staff')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Owner only' })
@Permissions('staff.manage')
@UseGuards(TenantGuard)
@Controller('staff/invitations')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Post()
  @ApiCreatedResponse({
    type: CreatedInvitationDto,
    description:
      'method "link": invite link (48 h, single use); method "password": account with a temporary password',
  })
  @ApiConflictResponse({ description: 'PHONE_TAKEN' })
  invite(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateInvitationDto,
  ): Promise<CreatedInvitationDto> {
    return this.staff.invite(user, dto);
  }

  @Get()
  @ApiOkResponse({ type: InvitationListDto })
  list(): Promise<InvitationListDto> {
    return this.staff.list();
  }

  @Delete(':id')
  @ApiOkResponse({ type: InvitationDto, description: 'Cancelled, not deleted' })
  @ApiNotFoundResponse()
  cancel(@Param('id', ParseUUIDPipe) id: string): Promise<InvitationDto> {
    return this.staff.cancel(id);
  }
}
