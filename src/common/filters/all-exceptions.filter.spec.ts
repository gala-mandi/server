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
});
