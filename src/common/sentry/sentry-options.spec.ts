import type { ErrorEvent } from '@sentry/nestjs';
import {
  maskText,
  scrubBreadcrumb,
  scrubEvent,
  sentryOptions,
} from './sentry-options';

describe('sentryOptions', () => {
  it('is off without SENTRY_DSN', () => {
    expect(sentryOptions({})).toBeNull();
    expect(sentryOptions({ SENTRY_DSN: '  ' })).toBeNull();
  });

  it('sends errors only, with environment and release, and no request data', () => {
    const options = sentryOptions({
      SENTRY_DSN: 'https://key@o1.ingest.sentry.io/1',
      NODE_ENV: 'production',
      SENTRY_RELEASE: 'server@abc123',
    });

    expect(options).toMatchObject({
      dsn: 'https://key@o1.ingest.sentry.io/1',
      environment: 'production',
      release: 'server@abc123',
      includeLocalVariables: false,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpBodies: [],
        urlQueryParams: false,
        stackFrameVariables: false,
      },
    });
    expect(options?.tracesSampleRate).toBeUndefined();
    expect(options?.tracesSampler).toBeUndefined();
  });

  it('prefers SENTRY_ENVIRONMENT over NODE_ENV', () => {
    expect(
      sentryOptions({
        SENTRY_DSN: 'https://key@o1.ingest.sentry.io/1',
        NODE_ENV: 'production',
        SENTRY_ENVIRONMENT: 'production-pk',
      })?.environment,
    ).toBe('production-pk');
  });
});

describe('maskText', () => {
  it('masks phone numbers, CNICs and e-mail addresses', () => {
    expect(
      maskText(
        'Key (phone)=(03001234567) exists; +92 300 1234567; 35202-1234567-1; a.b@shop.pk',
      ),
    ).toBe('Key (phone)=([number]) exists; [number]; [number]; [email]');
  });

  it('hides the values of a failed query', () => {
    expect(
      maskText('Failed query: select 1 where name = $1\nparams: Ali Khan,7'),
    ).toBe('Failed query: select 1 where name = $1\nparams: [hidden]');
  });

  it('keeps ordinary text, short numbers and UUIDs readable', () => {
    const text =
      'purchase 5f0c2c1e-8a8b-4b55-9a51-1d2f3e4a5b6c failed on line 42';
    expect(maskText(text)).toBe(text);
  });
});

describe('scrubEvent', () => {
  it('drops request bodies, cookies, query strings and unsafe headers', () => {
    const event = scrubEvent({
      type: undefined,
      request: {
        url: 'https://api.example.com/traders?search=03001234567',
        method: 'POST',
        data: { identifier: '03001234567', password: 'secret' },
        cookies: { refresh_token: 'abc' },
        query_string: 'search=03001234567',
        headers: {
          Authorization: 'Bearer abc',
          Cookie: 'refresh_token=abc',
          'User-Agent': 'Mozilla',
        },
      },
      user: { id: 'u1', email: 'a@b.pk', ip_address: '1.2.3.4' },
    });

    expect(event.request).toEqual({
      url: 'https://api.example.com/traders',
      method: 'POST',
      headers: { 'User-Agent': 'Mozilla' },
    });
    expect(event.user).toEqual({ id: 'u1' });
  });

  it('masks numbers in messages and exceptions and drops frame variables', () => {
    const event = scrubEvent({
      type: undefined,
      message: 'failed for 03001234567',
      exception: {
        values: [
          {
            type: 'Error',
            value: 'duplicate key (phone)=(03001234567)',
            stacktrace: { frames: [{ vars: { password: 'x' } }] },
          },
        ],
      },
      extra: { detail: 'Key (cnic)=(35202-1234567-1)', passwordHash: 'x' },
    });

    expect(event.message).toBe('failed for [number]');
    expect(event.exception?.values?.[0].value).toBe(
      'duplicate key (phone)=([number])',
    );
    expect(event.exception?.values?.[0].stacktrace?.frames?.[0].vars).toBe(
      undefined,
    );
    expect(event.extra).toEqual({ detail: 'Key (cnic)=([number])' });
  });
});

describe('scrubBreadcrumb', () => {
  it('removes query strings and secret fields from breadcrumb data', () => {
    expect(
      scrubBreadcrumb({
        category: 'http',
        message: 'GET /traders?search=03001234567',
        data: {
          url: 'https://api.example.com/traders?search=03001234567',
          token: 'abc',
          status_code: 500,
        },
      }),
    ).toEqual({
      category: 'http',
      message: 'GET /traders?search=[number]',
      data: { url: 'https://api.example.com/traders', status_code: 500 },
    });
  });
});
