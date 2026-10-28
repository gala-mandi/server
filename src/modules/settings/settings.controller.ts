import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiPayloadTooLargeResponse,
  ApiTags,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { checkLogo, LOGO_MAX_BYTES } from './logo-file';
import { LogoTooLargeFilter } from './logo-too-large.filter';
import { SettingsDto, UpdateSettingsDto } from './settings.dto';
import { SettingsService } from './settings.service';

@ApiTags('settings')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Owner only' })
@Permissions('settings.manage')
@UseGuards(TenantGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOkResponse({ type: SettingsDto })
  get(): Promise<SettingsDto> {
    return this.settings.get();
  }

  @Patch()
  @ApiOkResponse({
    type: SettingsDto,
    description:
      'Send only the fields that change. New purchases use the new rates; saved ones keep theirs.',
  })
  @ApiBadRequestResponse({ description: 'Field errors' })
  update(@Body() dto: UpdateSettingsDto): Promise<SettingsDto> {
    return this.settings.update(dto);
  }

  @Post('logo')
  @HttpCode(HttpStatus.OK)
  @UseFilters(LogoTooLargeFilter)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: LOGO_MAX_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOkResponse({ type: SettingsDto })
  @ApiBadRequestResponse({
    description: 'FILE_REQUIRED | INVALID_FILE_TYPE (PNG or JPG only)',
  })
  @ApiPayloadTooLargeResponse({ description: 'FILE_TOO_LARGE (over 1 MB)' })
  uploadLogo(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<SettingsDto> {
    return this.settings.uploadLogo(checkLogo(file));
  }
}
