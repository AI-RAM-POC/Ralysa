// The audit REST API (F-002 design §3.4.4–§3.4.6): the service ingest path, the client-attested
// path and the query. No PUT, PATCH or DELETE exists under `/v1/audit` (AC-11).
import { z } from 'zod';
import { Audience, TokenRejectReason } from '../auth/claims.js';
import { Problem } from '../common/errors.js';
import { Sha256Hex, SpanId, TraceId } from '../common/ids.js';
import { CLIENT_ACTION_ALLOWLIST } from '../audit/client-allowlist.js';
import { AuditEvent, AuditEventInput, IJson, Outcome } from '../audit/envelope.js';

// ---- Service path: POST /v1/audit/events (AC-11) ----

export const ServiceEventsRequest = z.strictObject({
  events: z.array(AuditEventInput).min(1).max(100),
});
export type ServiceEventsRequest = z.infer<typeof ServiceEventsRequest>;

export const IngestStatus = z.enum(['stored', 'duplicate']);

/**
 * The service path adds `aggregated`: an `auth.token_rejected` report taken by the rejection
 * aggregator (§6.4, SEC-F002-16), written individually or counted in a per-minute summary.
 */
export const ServiceIngestStatus = z.enum(['stored', 'duplicate', 'aggregated']);

export const ServiceEventsResponse = z.strictObject({
  results: z.array(z.strictObject({ event_id: z.uuid(), status: ServiceIngestStatus })),
});
export type ServiceEventsResponse = z.infer<typeof ServiceEventsResponse>;

/**
 * `details` of an `auth.token_rejected` report a verifying service sends on the service path
 * (§3.5, §6.4; T11-2). The control plane aggregates reports per client /24 or /64, reason and
 * audience before storing them. `dropped_count` reports rejections the service's reporter
 * couldn't queue (its buffer was full); they carry no client address.
 */
export const TokenRejectedReportDetails = z.strictObject({
  audience: Audience,
  reason: TokenRejectReason,
  /** The rejected caller's address, as the service saw it (IPv4 or IPv6). */
  client_ip: z.string().max(45).optional(),
  dropped_count: z.int().min(1).max(1_000_000).optional(),
});
export type TokenRejectedReportDetails = z.infer<typeof TokenRejectedReportDetails>;

// ---- Client-attested path: POST /v1/audit/client-events (AC-16) ----

export const ClientAuditEventInput = z.strictObject({
  event_id: z.uuid(),
  client_seq: z.int().min(1),
  action: z.enum(CLIENT_ACTION_ALLOWLIST),
  /** Only on `session.ended`: the last `client_seq` of the session, for tail reconciliation. */
  final_seq: z.int().min(0).optional(),
  resource: z.strictObject({ type: z.literal('local_tool'), id: z.string().max(128) }).nullable(),
  operation: z.string().max(32).nullable(),
  /** Null on `*.requested`. */
  outcome: Outcome.nullable(),
  reason_code: z.string().max(64).nullable(),
  tool_call_id: z.string().max(64).nullable(),
  turn_id: z.string().max(64).nullable(),
  trace_id: TraceId,
  span_id: SpanId.nullable(),
  payload_hash: Sha256Hex.nullable(),
  /** Stored as `details.client.*`; `client_ts`, `pack_id` and `agent_id` go here. */
  client: z.record(z.string(), IJson),
});
export type ClientAuditEventInput = z.infer<typeof ClientAuditEventInput>;

export const ClientEventsRequest = z.strictObject({
  /** Absent only when `events[0]` is `session.started`; the server then issues one. */
  session_id: z.uuid().optional(),
  events: z.array(ClientAuditEventInput).min(1).max(50),
});
export type ClientEventsRequest = z.infer<typeof ClientEventsRequest>;

export const IntentAck = z.strictObject({
  event_id: z.uuid(),
  ack: z.boolean(),
  governance: z.strictObject({
    epoch: z.int(),
    halted: z.boolean(),
    reason_category: z.string().max(64).nullable(),
  }),
});
export type IntentAck = z.infer<typeof IntentAck>;

export const ClientEventsResponse = z.strictObject({
  session_id: z.uuid(),
  results: z.array(
    z.strictObject({ event_id: z.uuid(), status: IngestStatus, ack: IntentAck.optional() }),
  ),
});
export type ClientEventsResponse = z.infer<typeof ClientEventsResponse>;

/**
 * `503 audit_unavailable` on the client path (G-5, G-6; SEC-F002-14): nothing was stored, and every
 * intent in the batch is answered `ack: false`, so an honest host runs no local tool.
 */
export const ClientEventsUnavailable = Problem.extend({ acks: z.array(IntentAck) });
export type ClientEventsUnavailable = z.infer<typeof ClientEventsUnavailable>;

/** Open client sessions per auth session (`sid`); beyond it, 429 [SEC-F002-14]. */
export const CLIENT_SESSIONS_MAX_OPEN = 20;
/** Client events accepted per user per minute; beyond it, 429 (§3.4.5). */
export const CLIENT_EVENTS_PER_USER_PER_MINUTE = 600;
/** An open `client_seq` gap becomes final (`audit.client_seq_gap`) after this long idle. */
export const CLIENT_GAP_FINAL_AFTER_MS = 15 * 60 * 1000;
/** A session without `session.ended` for this long is `audit.client_session_unterminated`. */
export const CLIENT_SESSION_UNTERMINATED_AFTER_MS = 24 * 60 * 60 * 1000;

// ---- Query: GET /v1/audit/events (AC-12) ----

/** Query strings arrive as strings; the server parses `limit` after validation. */
export const AuditQuery = z.strictObject({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  user_id: z.uuid().optional(),
  action: z.string().max(100).optional(),
  outcome: Outcome.optional(),
  /** 1–500. */
  limit: z
    .string()
    .regex(/^(?:[1-9]\d?|[1-4]\d\d|500)$/)
    .optional(),
  cursor: z.string().max(256).optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AUDIT_QUERY_MAX_RANGE_DAYS = 31;
export const AUDIT_QUERY_MAX_LIMIT = 500;

/** A stored event with its seal when sealed. */
export const AuditEventView = AuditEvent.extend({
  seal: z.strictObject({ shard: z.string().max(64), seq: z.int().min(1) }).nullable(),
});
export type AuditEventView = z.infer<typeof AuditEventView>;

export const AuditQueryResponse = z.strictObject({
  events: z.array(AuditEventView),
  next_cursor: z.string().max(256).nullable(),
});
export type AuditQueryResponse = z.infer<typeof AuditQueryResponse>;
