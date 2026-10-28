import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ErrorBody } from '../../common/filters/all-exceptions.filter';
import { LOGO_TOO_LARGE } from './logo-file';

/** Multer stops reading at the size limit; give the user a clear message. */
@Catch(PayloadTooLargeException)
export class LogoTooLargeFilter implements ExceptionFilter {
  catch(exception: PayloadTooLargeException, host: ArgumentsHost): void {
    // Multer's other limits (too many parts or fields) keep their own text.
    const body: ErrorBody =
      exception.message === 'File too large'
        ? {
            statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
            message: LOGO_TOO_LARGE,
            code: 'FILE_TOO_LARGE',
            errors: [{ field: 'file', message: LOGO_TOO_LARGE }],
          }
        : {
            statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
            message: exception.message,
          };
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(body.statusCode)
      .json(body);
  }
}
