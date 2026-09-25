// Builders for the RTS's auth events (§3.5 catalogue): the actor is the user the event is about
// (user id and IdP subject), or the service for client_credentials. Denials go through
// AuditWriter.writeOrSpool (a denial stands even when its audit write fails, ADR-0022 rule 5).
import type { Outcome } from '@ralysa/protocol/audit';
import { uuidv7 } from '@ralysa/protocol/common';
import type { StoredEventInput } from '../audit/columns.js';

export interface AuthEventFields {
  action: string;
  outcome: Outcome;
  reasonCode?: string;
  traceId: string;
  user?: { id: string; idpSubject: string };
  service?: string;
  sessionId?: string;
  surface?: 'cli' | 'desktop' | 'web' | 'automation' | 'console';
  policyVersion?: string;
  details: Record<string, unknown>;
}

export function authEvent(fields: AuthEventFields): StoredEventInput {
  const actor =
    fields.service !== undefined
      ? { type: 'service' as const, user_id: null, idp_subject: null, service: fields.service }
      : {
          type: 'user' as const,
          user_id: fields.user?.id ?? null,
          idp_subject: fields.user?.idpSubject ?? null,
          service: null,
        };
  return {
    event_id: uuidv7(),
    action: fields.action,
    actor,
    outcome: fields.outcome,
    reason_code: fields.reasonCode ?? null,
    session_id: fields.sessionId ?? null,
    surface: fields.surface ?? null,
    trace_id: fields.traceId,
    policy_version: fields.policyVersion ?? null,
    details: fields.details as StoredEventInput['details'],
    source: 'control-plane',
    attestation: 'server',
  };
}
