// Shared error codes and the RFC 9457 problem body every `/v1` error uses (F-002 design §3.1,
// §3.9). OAuth endpoints use the RFC 6749 §5.2 body instead (`@ralysa/protocol/auth`).
import { z } from 'zod';
import { TraceId } from './ids.js';

export const ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'locked',
  'payload_too_large',
  'unprocessable',
  'rate_limited',
  /** The audit write failed or exceeded its budget; the caller must fail closed (ADR-0022). */
  'audit_unavailable',
  'temporarily_unavailable',
  'internal',
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** A stable problem `type` URI per code. A URN, so it names the problem without a domain. */
export const problemType = (code: ErrorCode): string => `urn:ralysa:problem:${code}`;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * RFC 9457 problem details. `i18n_key` lets a client show an en/ar message for user-facing
 * errors; `trace_id` joins the error to the logs and audit trail. Loose, because RFC 9457 allows
 * extension members.
 */
export const Problem = z.looseObject({
  type: z.string().regex(/^urn:ralysa:problem:[a-z_]+$/),
  title: z.string().max(200),
  status: z.int().min(400).max(599),
  detail: z.string().max(1000).optional(),
  instance: z.string().max(200).optional(),
  code: ErrorCode,
  i18n_key: z.string().max(100).optional(),
  trace_id: TraceId.optional(),
});
export type Problem = z.infer<typeof Problem>;
