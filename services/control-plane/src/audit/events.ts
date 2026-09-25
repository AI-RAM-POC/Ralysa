// Builders for the audit events the control plane itself writes (§3.5 catalogue). Server-set
// facts go under `details` (or `details.server` where a client also contributes).
import type { Outcome } from '@ralysa/protocol/audit';
import { newTraceId, uuidv7 } from '@ralysa/protocol/common';
import type { StoredEventInput } from './columns.js';
import type { Rejection } from './rejections.js';

export interface SystemEventFields {
  action: string;
  outcome: Outcome;
  /** actor.service, e.g. `migrator`, `audit-store`, `rts`. */
  service: string;
  reasonCode?: string;
  traceId?: string;
  details: Record<string, unknown>;
}

export function systemEvent(fields: SystemEventFields): StoredEventInput {
  return {
    event_id: uuidv7(),
    action: fields.action,
    actor: { type: 'system', user_id: null, idp_subject: null, service: fields.service },
    outcome: fields.outcome,
    reason_code: fields.reasonCode ?? null,
    trace_id: fields.traceId ?? newTraceId(),
    details: fields.details as StoredEventInput['details'],
    source: 'control-plane',
    attestation: 'server',
  };
}

/**
 * auth.token_rejected (§3.5, §6.4). The caller is unauthenticated, so the actor is an unknown user.
 * `suppressed_count` is present only on the per-minute summary.
 */
export function tokenRejectedEvent(
  rejection: Rejection & { network: string; suppressedCount?: number },
): StoredEventInput {
  return {
    event_id: uuidv7(),
    action: 'auth.token_rejected',
    actor: { type: 'user', user_id: null, idp_subject: null, service: null },
    outcome: 'denied',
    reason_code: rejection.reason,
    trace_id: rejection.traceId,
    details: {
      audience: rejection.audience,
      reason: rejection.reason,
      client_ip: rejection.clientIp,
      client_network: rejection.network,
      ...(rejection.suppressedCount === undefined
        ? {}
        : { suppressed_count: rejection.suppressedCount }),
    },
    source: 'control-plane',
    attestation: 'server',
  };
}

/** db.migration.applied, one per applied migration (SR-29), actor.service = migrator. */
export function migrationAppliedEvents(
  set: 'cp' | 'audit',
  applied: readonly string[],
  checksums: Readonly<Record<string, string>>,
): StoredEventInput[] {
  return applied.map((migration) =>
    systemEvent({
      action: 'db.migration.applied',
      outcome: 'success',
      service: 'migrator',
      details: { set, migration, checksum: checksums[`${set}/${migration}.ts`] ?? 'unknown' },
    }),
  );
}
