import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';

export interface FieldError {
  field: string;
  message: string;
}

export interface ErrorBody {
  statusCode: number;
  message: string;
  errors?: FieldError[];
  /** Machine-readable reason, e.g. `ACCOUNT_DISABLED`. */
  code?: string;
}

/**
 * Turns every error into `{ statusCode, message, errors? }`.
 * Stack traces are logged, never sent to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const ctx = host.switchToHttp();
    const body = this.toBody(exception);

    if (body.statusCode >= 500) {
      this.logger.error(
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    httpAdapter.reply(ctx.getResponse(), body, body.statusCode);
  }

  toBody(exception: unknown): ErrorBody {
    if (exception instanceof ZodValidationException) {
      const zodError = exception.getZodError();
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Validation failed',
        errors: zodError instanceof ZodError ? toFieldErrors(zodError) : [],
      };
    }

    if (exception instanceof HttpException) {
      return {
        statusCode: exception.getStatus(),
        message: messageOf(exception),
        ...extrasOf(exception),
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    };
  }
}

function toFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  }));
}

/** Keeps `code` and `errors` when a service throws them on purpose. */
function extrasOf(
  exception: HttpException,
): Pick<ErrorBody, 'code' | 'errors'> {
  const response = exception.getResponse();
  if (typeof response !== 'object' || response === null) return {};

  const { code, errors } = response as { code?: unknown; errors?: unknown };
  return {
    ...(typeof code === 'string' && { code }),
    ...(Array.isArray(errors) && { errors: errors as FieldError[] }),
  };
}

function messageOf(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;

  const message = (response as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join(', ');
  return exception.message;
}
