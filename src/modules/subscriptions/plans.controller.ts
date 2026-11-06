import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import { Permissions } from '../../common/decorators/permissions.decorator';
import {
  CreatePlanDto,
  ListPlansQueryDto,
  PlanDto,
  PlanPageDto,
  PlanRemovedDto,
  UpdatePlanDto,
} from './plans.dto';
import { PlansService } from './plans.service';

@ApiTags('admin: plans')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Super-admin only' })
@Permissions('plan.manage')
@Controller('admin/plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @ApiOkResponse({ type: PlanPageDto })
  list(@Query() query: ListPlansQueryDto): Promise<PlanPageDto> {
    return this.plans.list(query);
  }

  @Post()
  @ApiCreatedResponse({ type: PlanDto })
  @ApiConflictResponse({ description: 'PLAN_NAME_TAKEN' })
  create(@Body() dto: CreatePlanDto): Promise<PlanDto> {
    return this.plans.create(dto);
  }

  @Get(':id')
  @ApiOkResponse({ type: PlanDto })
  @ApiNotFoundResponse()
  get(@Param('id', ParseUUIDPipe) id: string): Promise<PlanDto> {
    return this.plans.get(id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: PlanDto })
  @ApiConflictResponse({ description: 'PLAN_NAME_TAKEN | TRIAL_PLAN_LOCKED' })
  @ApiNotFoundResponse()
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlanDto,
  ): Promise<PlanDto> {
    return this.plans.update(id, dto);
  }

  @Delete(':id')
  @ApiOkResponse({
    type: PlanRemovedDto,
    description:
      'Deleted when no shop ever used it; otherwise deactivated (is_active=false)',
  })
  @ApiConflictResponse({ description: 'TRIAL_PLAN_LOCKED' })
  @ApiNotFoundResponse()
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<PlanRemovedDto> {
    return this.plans.remove(id);
  }
}
