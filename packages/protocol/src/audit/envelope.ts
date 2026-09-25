// The audit envelope (F-002 design §3.5; observability-audit §3.1). Shapes only: no transforms
// and no refinements that change the wire shape, so the generated JSON Schema is the contract.
// The rules zod can't express in the schema (I-JSON `details`, `failure` only on `auth.*`) are
// checked at ingest with `iJsonViolations()` and `outcomeAllowed()`.
import { z } from 'zod';
import { Region, Sha256Hex, SpanId, TraceId } from '../common/ids.js';
import { AUDIT_SCHEMA_VERSION } from './version.js';

/**
 * Any JSON value. At ingest `details` must also be I-JSON (RFC 7493): numbers are finite and,
 * when integral, safe integers; strings have no lone surrogates. See `iJsonViolations()`.
 */
export const IJson = z.json();

/** `failure` is valid on `auth.*` only [AR-3]; see `outcomeAllowed()`. */
export const Outcome = z.enum([
  'success',
  'failure',
  'denied',
  'error',
  'cancelled',
  'approved',
  'rejected',
  'expired',
]);
export type Outcome = z.infer<typeof Outcome>;

/** The shard of the hash chain in Phase 0 (§4.6). Set by the server, never by the body. */
export const Source = z.enum([
  'control-plane',
  'model-gateway',
  'mcp-gateway',
  'workspace-runtime',
  'agent-host-server',
  'agent-host-local',
]);
export type Source = z.infer<typeof Source>;

export const Actor = z.strictObject({
  type: z.enum(['user', 'service', 'system']),
  /** Null before authentication succeeded. */
  user_id: z.uuid().nullable(),
  idp_subject: z.string().max(128).nullable(),
  service: z.string().max(64).nullable(),
});
export type Actor = z.infer<typeof Actor>;

/** Audit action names: 2–4 lowercase dot-separated segments, for example `auth.sign_in`. */
export const ActionName = z.string().regex(/^[a-z_]+(\.[a-z_]+){1,3}$/);

/** What a service submits. The server adds `org_id`, `source`, `attestation` and `ts`. */
export const AuditEventInput = z.strictObject({
  event_id: z.uuid(),
  action: ActionName,
  actor: Actor,
  act: z
    .strictObject({ sub: z.string().max(200) })
    .nullable()
    .optional(),
  surface: z.enum(['cli', 'desktop', 'web', 'automation', 'console']).nullable().optional(),
  resource: z
    .strictObject({ type: z.string().max(40), id: z.string().max(200) })
    .nullable()
    .optional(),
  operation: z.string().max(32).nullable().optional(),
  outcome: Outcome,
  reason_code: z.string().max(64).nullable().optional(),
  session_id: z.string().max(64).nullable().optional(),
  turn_id: z.string().max(64).nullable().optional(),
  request_id: z.string().max(64).nullable().optional(),
  tool_call_id: z.string().max(64).nullable().optional(),
  trace_id: TraceId,
  span_id: SpanId.nullable().optional(),
  policy_version: z.string().max(64).nullable().optional(),
  entitlement_version: z.int().nullable().optional(),
  tier: z.enum(['T1', 'T2', 'T3']).nullable().optional(),
  classification: z.string().max(16).nullable().optional(),
  endpoint_id: z.string().max(100).nullable().optional(),
  /** BC-04: where the model endpoint is hosted. */
  endpoint_region: Region.nullable().optional(),
  /** SR-04: where inference was processed. */
  inference_region: Region.nullable().optional(),
  inference_region_source: z.enum(['registry_declared', 'provider_reported']).nullable().optional(),
  locality: z.enum(['local', 'in_country', 'in_region', 'global']).nullable().optional(),
  tokens_in: z.int().min(0).nullable().optional(),
  tokens_out: z.int().min(0).nullable().optional(),
  cache_read_tokens: z.int().min(0).nullable().optional(),
  cache_write_tokens: z.int().min(0).nullable().optional(),
  payload_hash: Sha256Hex.nullable().optional(),
  details: z.record(z.string(), IJson),
});
export type AuditEventInput = z.infer<typeof AuditEventInput>;

/** Stored form = input + server-assigned fields. The canonical form the sealer hashes (§4.6). */
export const AuditEvent = AuditEventInput.extend({
  schema_version: z.literal(AUDIT_SCHEMA_VERSION),
  /** RFC 3339 UTC with exactly 3 fractional digits and `Z` [AR-5]. */
  ts: z.iso.datetime({ precision: 3 }),
  org_id: z.uuid(),
  source: Source,
  attestation: z.enum(['server', 'client']),
  client_seq: z.int().nullable().optional(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;
