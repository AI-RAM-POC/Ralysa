// Errors (F-002 design §3.1, §3.9): /v1 and /.well-known answer RFC 9457 problem+json with a
// stable `type` URN and, for user-facing errors, an i18n key; /oauth2/* answers RFC 6749 §5.2
// OAuth errors. Neither ever echoes input or internal detail.
import {
  type ErrorCode,
  PROBLEM_CONTENT_TYPE,
  type Problem,
  problemType,
} from '@ralysa/protocol/common';
import type { OAuthError } from '@ralysa/protocol/auth';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { errorSummary } from './logging.js';

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  locked: 423,
  payload_too_large: 413,
  unprocessable: 422,
  rate_limited: 429,
  audit_unavailable: 503,
  temporarily_unavailable: 503,
  internal: 500,
};

const TITLE: Partial<Record<ErrorCode, string>> = {
  invalid_request: 'Invalid request',
  unauthorized: 'Unauthorized',
  forbidden: 'Forbidden',
  not_found: 'Not found',
  unprocessable: 'Unprocessable request',
  rate_limited: 'Too many requests',
  audit_unavailable: 'Audit unavailable',
  temporarily_unavailable: 'Temporarily unavailable',
};

export class HttpProblem extends Error {
  readonly code: ErrorCode;
  readonly i18nKey: string | undefined;
  readonly headers: Record<string, string>;
  constructor(
    code: ErrorCode,
    detail?: string,
    options: { i18nKey?: string; headers?: Record<string, string> } = {},
  ) {
    super(detail ?? code);
    this.name = 'HttpProblem';
    this.code = code;
    this.i18nKey = options.i18nKey;
    this.headers = options.headers ?? {};
  }
}

export class OAuthProblem extends Error {
  readonly body: OAuthError;
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(body: OAuthError, status = 400, headers: Record<string, string> = {}) {
    super(body.error);
    this.name = 'OAuthProblem';
    this.body = body;
    this.status = status;
    this.headers = headers;
  }
}

export function statusOf(code: ErrorCode): number {
  return STATUS[code];
}

export function problemBody(
  code: ErrorCode,
  request: FastifyRequest,
  options: { detail?: string; i18nKey?: string } = {},
): Problem {
  return {
    type: problemType(code),
    title: TITLE[code] ?? code,
    status: statusOf(code),
    code,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.i18nKey === undefined ? {} : { i18n_key: options.i18nKey }),
    trace_id: request.traceId,
  };
}

export function sendProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  code: ErrorCode,
  options: { detail?: string; i18nKey?: string } = {},
): FastifyReply {
  return reply
    .status(statusOf(code))
    .type(PROBLEM_CONTENT_TYPE)
    .send(problemBody(code, request, options));
}

const isOAuthRoute = (request: FastifyRequest): boolean =>
  (request.routeOptions.url ?? request.url).startsWith('/oauth2/');

/** The one error handler: typed problems pass through; anything else is a bare 500. */
export function handleError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof OAuthProblem) {
    for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
    return reply.status(error.status).header('cache-control', 'no-store').send(error.body);
  }
  if (error instanceof HttpProblem) {
    for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
    return sendProblem(reply, request, error.code, {
      ...(error.i18nKey === undefined ? {} : { i18nKey: error.i18nKey }),
    });
  }
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // Fastify's own client errors (bad JSON, body too large, unsupported media type).
    const code: ErrorCode =
      status === 413 ? 'payload_too_large' : status === 415 ? 'unprocessable' : 'invalid_request';
    if (isOAuthRoute(request)) {
      return reply
        .status(400)
        .header('cache-control', 'no-store')
        .send({ error: 'invalid_request' });
    }
    return sendProblem(reply, request, code);
  }
  request.log.error({ error: errorSummary(error) }, 'unhandled_error');
  if (isOAuthRoute(request)) {
    return reply
      .status(503)
      .header('cache-control', 'no-store')
      .send({ error: 'temporarily_unavailable' });
  }
  return sendProblem(reply, request, 'internal');
}
