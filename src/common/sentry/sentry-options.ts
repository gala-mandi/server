import type { Breadcrumb, ErrorEvent, NodeOptions } from '@sentry/nestjs';

/**
 * Sentry settings for the API. Sentry is on only when `SENTRY_DSN` is set,
 * so local runs and tests never send anything.
 *
 * Only errors are sent (no tracing, no profiling) and personal data is kept
 * out: no request bodies, cookies, query strings or most headers, and phone
 * numbers, CNICs and e-mail addresses are masked in every text we send.
 */
export function sentryOptions(env: NodeJS.ProcessEnv): NodeOptions | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  return {
    dsn,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'development',
    // Without SENTRY_RELEASE the SDK picks up a commit SHA from the host's
    // usual variables (SOURCE_COMMIT, GITHUB_SHA, …) when there is one.
    ...(env.SENTRY_RELEASE && { release: env.SENTRY_RELEASE }),
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: SAFE_HEADERS }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
    },
    includeLocalVariables: false,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}

const SAFE_HEADERS = ['user-agent', 'content-type', 'accept', 'content-length'];

/** Keys whose values are never sent, wherever they appear. */
const SECRET_KEY =
  /pass|token|secret|cookie|authori[sz]ation|otp|cnic|phone|mobile|email|identifier/i;

/**
 * Phone numbers (03001234567, +92 300 1234567), CNICs (35202-1234567-1) and
 * any other run of 10+ digits, and e-mail addresses.
 */
const LONG_NUMBER = /\+?\d[\d\s-]{8,}\d/g;
const EMAIL = /[^\s@"'()<>,;]+@[^\s@"'()<>,;]+\.[^\s@"'()<>,;]+/g;

/** Drizzle's "Failed query: … params: <values>": the values are user data. */
const QUERY_PARAMS = /\bparams: [\s\S]*$/;

export function maskText(text: string): string {
  return text
    .replace(QUERY_PARAMS, 'params: [hidden]')
    .replace(EMAIL, '[email]')
    .replace(LONG_NUMBER, '[number]');
}

function withoutQuery(url: string): string {
  const index = url.search(/[?#]/);
  return index === -1 ? url : url.slice(0, index);
}

/** Masks strings and drops secret keys, at any depth. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return maskText(value);
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!SECRET_KEY.test(key)) out[key] = scrubValue(v, depth + 1);
  }
  return out;
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    const { url, method, headers } = event.request;
    event.request = {
      ...(url && { url: withoutQuery(url) }),
      ...(method && { method }),
      ...(headers && {
        headers: Object.fromEntries(
          Object.entries(headers).filter(([name]) =>
            SAFE_HEADERS.includes(name.toLowerCase()),
          ),
        ),
      }),
    };
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : {};
  if (event.message) event.message = maskText(event.message);
  if (event.logentry?.message) {
    event.logentry = { message: maskText(event.logentry.message) };
  }
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = maskText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
  }
  if (event.extra) event.extra = scrubValue(event.extra) as ErrorEvent['extra'];
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) =>
      scrubBreadcrumb(crumb),
    );
  }
  return event;
}

export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  const data = crumb.data;
  return {
    ...crumb,
    ...(crumb.message && { message: maskText(crumb.message) }),
    ...(data && {
      data: scrubValue({
        ...data,
        ...(typeof data.url === 'string' && { url: withoutQuery(data.url) }),
      }) as Breadcrumb['data'],
    }),
  };
}
