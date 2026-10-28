import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { UserRolesService } from '../users/user-roles.service';
import { TokensService } from '../auth/tokens.service';
import {
  ChangeRoleDto,
  StaffListDto,
  StaffMemberDto,
} from './staff-members.dto';

@ApiTags('staff')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Owner only' })
@Permissions('staff.manage')
@UseGuards(TenantGuard)
@Controller('staff')
export class StaffMembersController {
  constructor(
    private readonly roles: UserRolesService,
    private readonly tokens: TokensService,
  ) {}

  @Get()
  @ApiOkResponse({ type: StaffListDto })
  async list(@CurrentUser() actor: AuthUser): Promise<StaffListDto> {
    return { data: await this.roles.list(actor) };
  }

  @Patch(':id/role')
  @ApiOkResponse({
    type: StaffMemberDto,
    description: "Applies at the user's next token refresh",
  })
  @ApiBadRequestResponse({ description: 'A shop needs at least one owner' })
  @ApiNotFoundResponse()
  changeRole(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeRoleDto,
  ): Promise<StaffMemberDto> {
    return this.roles.changeRole(actor, id, dto.role);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: StaffMemberDto,
    description: 'Signed out at once; sign-in gives 403 ACCOUNT_DISABLED',
  })
  @ApiBadRequestResponse({
    description: 'CANNOT_DEACTIVATE_SELF | last active owner',
  })
  @ApiNotFoundResponse()
  async deactivate(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StaffMemberDto> {
    const member = await this.roles.setActive(actor, id, false);
    await this.tokens.revokeAllForUser(id);
    return member;
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: StaffMemberDto })
  @ApiNotFoundResponse()
  activate(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StaffMemberDto> {
    return this.roles.setActive(actor, id, true);
  }
}
