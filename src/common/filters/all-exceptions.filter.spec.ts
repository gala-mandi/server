import {
  ArgumentsHost,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';
import { AllExceptionsFilter } from './all-exceptions.filter';

function setup() {
  const reply = jest.fn();
  const adapterHost = { httpAdapter: { reply } } as unknown as HttpAdapterHost;
  const filter = new AllExceptionsFilter(adapterHost);
  const response = {};
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { filter, reply, host, response };
}

describe('AllExceptionsFilter', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps the status and message of an HttpException', () => {
    const { filter, reply, host, response } = setup();

    filter.catch(new NotFoundException('Cannot GET /nope'), host);

    expect(reply).toHaveBeenCalledWith(
      response,
      { statusCode: 404, message: 'Cannot GET /nope' },
      404,
    );
  });

  it('returns 429 for throttled requests', () => {
    const { filter } = setup();

    expect(filter.toBody(new ThrottlerException())).toEqual({
      statusCode: 429,
      message: 'ThrottlerException: Too Many Requests',
    });
  });

  it('joins an array message into one string', () => {
    const { filter } = setup();

    expect(
      filter.toBody(new BadRequestException(['a is bad', 'b is bad'])),
    ).toEqual({ statusCode: 400, message: 'a is bad, b is bad' });
  });

  it('keeps a code and field errors thrown on purpose', () => {
    const { filter } = setup();

    expect(
      filter.toBody(
        new BadRequestException({
          message: 'Invalid or expired code',
          code: 'INVALID_OTP',
          errors: [{ field: 'code', message: 'Invalid or expired code' }],
        }),
      ),
    ).toEqual({
      statusCode: 400,
      message: 'Invalid or expired code',
      code: 'INVALID_OTP',
      errors: [{ field: 'code', message: 'Invalid or expired code' }],
    });
  });

  it('turns a Zod validation error into field errors', () => {
    const { filter } = setup();
    const schema = z.object({ phone: z.string().min(10), name: z.string() });
    const parsed = schema.safeParse({ phone: '123' });
    if (parsed.success) throw new Error('expected parse to fail');

    const body = filter.toBody(new ZodValidationException(parsed.error));

    expect(body.statusCode).toBe(400);
    expect(body.message).toBe('Validation failed');
    expect(body.errors?.map((e) => e.field)).toEqual(['phone', 'name']);
  });

  it('hides unknown errors behind a generic 500 without a stack trace', () => {
    const { filter, reply, host, response } = setup();

    filter.catch(new Error('db password is hunter2'), host);

    expect(reply).toHaveBeenCalledWith(
      response,
      { statusCode: 500, message: 'Internal server error' },
      500,
    );
  });

  it('keeps the 413 of a body over the size limit (body parser)', () => {
    const { filter, reply, host, response } = setup();
    // What raw-body / body-parser throw (http-errors).
    const error = Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      expose: true,
      type: 'entity.too.large',
    });

    filter.catch(error, host);

    expect(reply).toHaveBeenCalledWith(
      response,
      { statusCode: 413, message: 'The request body is too large' },
      413,
    );
  });

  it('still answers 500 for a server-side error that carries a status', () => {
    const { filter, reply, host, response } = setup();
    const error = Object.assign(new Error('internal'), {
      status: 500,
      expose: false,
      type: 'stream.encoding.set',
    });

    filter.catch(error, host);

    expect(reply).toHaveBeenCalledWith(
      response,
      { statusCode: 500, message: 'Internal server error' },
      500,
    );
  });
});
