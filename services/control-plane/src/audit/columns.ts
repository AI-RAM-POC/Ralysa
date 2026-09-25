// The audit envelope (§3.5) ↔ the audit.audit_event columns (§4.4). toColumns() is the writer's
// side; rowToEnvelope() (sealer/chain.ts) is the only way back, used by the sealer and every
// verifier, so the hashed form always comes from the stored row [AR-5].
import type { AuditEventInput, Source } from '@ralysa/protocol/audit';
import type { Insertable } from 'kysely';
import type { AuditEventTable } from '../db/types.js';

/** What the control plane stores: the input envelope plus the server-assigned provenance. */
export interface StoredEventInput extends AuditEventInput {
  source: Source;
  attestation: 'server' | 'client';
  client_seq?: number | null;
}

export function toColumns(orgId: string, event: StoredEventInput): Insertable<AuditEventTable> {
  const n = <T>(value: T | null | undefined): T | null => value ?? null;
  return {
    event_id: event.event_id,
    org_id: orgId,
    action: event.action,
    actor_type: event.actor.type,
    actor_user_id: event.actor.user_id,
    actor_idp_subject: event.actor.idp_subject,
    actor_service: event.actor.service,
    act_sub: n(event.act?.sub),
    surface: n(event.surface),
    resource_type: n(event.resource?.type),
    resource_id: n(event.resource?.id),
    operation: n(event.operation),
    outcome: event.outcome,
    reason_code: n(event.reason_code),
    session_id: n(event.session_id),
    turn_id: n(event.turn_id),
    request_id: n(event.request_id),
    tool_call_id: n(event.tool_call_id),
    trace_id: event.trace_id,
    span_id: n(event.span_id),
    policy_version: n(event.policy_version),
    entitlement_version: n(event.entitlement_version),
    tier: n(event.tier),
    classification: n(event.classification),
    endpoint_id: n(event.endpoint_id),
    endpoint_region: n(event.endpoint_region),
    inference_region: n(event.inference_region),
    inference_region_source: n(event.inference_region_source),
    locality: n(event.locality),
    tokens_in: n(event.tokens_in),
    tokens_out: n(event.tokens_out),
    cache_read_tokens: n(event.cache_read_tokens),
    cache_write_tokens: n(event.cache_write_tokens),
    payload_hash: n(event.payload_hash),
    source: event.source,
    attestation: event.attestation,
    client_seq: n(event.client_seq),
    details: JSON.stringify(event.details),
  };
}
