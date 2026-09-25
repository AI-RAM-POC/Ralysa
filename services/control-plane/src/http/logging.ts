// Logging for the serve process (F-002 design §6.6; AC-14; SEC-F002-21).
// - Fastify request logging is off; one line per request comes from the onResponse hook with the
//   ROUTE TEMPLATE, never the raw URL, so a query string (`code`, `state`) can't reach a log.
// - pino `redact` removes credential-bearing headers and body fields wherever they appear.
// - A formatters.log scrubber replaces JWTs, Ralysa refresh tokens and codes, OpenBao tokens and
//   credentials in connection strings anywhere in the record (defence in depth for library
//   errors).
// - Users appear as user_id only; the serializers never emit email or display name.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PinoLoggerOptions } from 'fastify/types/logger.js';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-vault-token"]',
  'res.headers["set-cookie"]',
  ...[
    'code',
    'code_verifier',
    'device_code',
    'refresh_token',
    'access_token',
    'id_token',
    'subject_token',
    'client_assertion',
    'assertion',
    'client_secret',
    'token',
    'state',
    'password',
  ].flatMap((field) => [field, `*.${field}`, `body.${field}`]),
];

const SECRET_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g, // JWT / JWS
  /\brly_(?:rt|ac)_[A-Za-z0-9_-]{8,}/g, // Ralysa refresh tokens and authorization codes
  /\b(?:hvs|hvb|hvr|s|b|r)\.[A-Za-z0-9_-]{20,}/g, // OpenBao/Vault token formats
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, // credentials in a URL
  /\b(?:client_secret|password|secret_id|code_verifier)=([^&\s"]+)/gi, // form-encoded secrets
];

/** Replaces anything that looks like a credential with [REDACTED]. */
export function scrubText(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match: string, prefix?: string) =>
      typeof prefix === 'string' && prefix.includes('://') ? `${prefix}[REDACTED]@` : '[REDACTED]',
    );
  }
  return out;
}

export const MAX_SCRUB_DEPTH = 8;

/**
 * Deep-scrubs every string in a log record. Anything nested deeper than MAX_SCRUB_DEPTH is
 * replaced as a whole: it can't be inspected, so it isn't logged (review of #25).
 */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_SCRUB_DEPTH) return '[REDACTED:depth]';
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = scrubValue(item, depth + 1);
  return out;
}

/** What a request line may contain: no URL, no query, no headers, no body. */
export function requestSummary(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    route: request.routeOptions.url ?? 'unmatched',
    request_id: request.id,
  };
}

export function responseSummary(
  request: FastifyRequest,
  reply: FastifyReply,
): Record<string, unknown> {
  return {
    ...requestSummary(request),
    status: reply.statusCode,
    latency_ms: Math.round(reply.elapsedTime),
  };
}

export function loggerOptions(level: string): PinoLoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label: string) => ({ level: label }),
      log: (record: Record<string, unknown>) => scrubValue(record) as Record<string, unknown>,
    },
    serializers: {
      // Nothing from the raw request or response objects: only the summaries above are logged.
      req: () => undefined,
      res: () => undefined,
      err: (error: Error & { code?: unknown; statusCode?: unknown }) => ({
        type: error.name,
        message: scrubText(error.message),
        code: typeof error.code === 'string' ? error.code : undefined,
        status: typeof error.statusCode === 'number' ? error.statusCode : undefined,
      }),
    },
    // The message string is scrubbed too: formatters.log only sees the merged object.
    hooks: {
      // Last line of defence: the final serialized line is scrubbed as text, which also covers
      // printf-style interpolation (`%o`, `%j`, `%s`) that the object and message scrubbing can't
      // see (re-review of #25).
      streamWrite: (line: string) => scrubText(line),
      logMethod(args, method) {
        method.apply(
          this,
          args.map((arg: unknown) =>
            typeof arg === 'string' ? scrubText(arg) : arg,
          ) as Parameters<typeof method>,
        );
      },
    },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    messageKey: 'msg',
    base: { service: 'control-plane' },
  };
}
