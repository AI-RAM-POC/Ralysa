// Builders for the audit events the control plane itself writes (§3.5 catalogue). Server-set
// facts go under `details` (or `details.server` where a client also contributes).
import type { Outcome, Source } from '@ralysa/protocol/audit';
import { newTraceId, uuidv7 } from '@ralysa/protocol/common';
import type { StoredEventInput } from './columns.js';
import type { EmittedRejection } from './rejections.js';

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
 * `suppressed_count` is present only on the per-minute summary. `source` is the verifier that
 * rejected the token: the control plane itself, or the service whose report this is (taken from
 * its service token, never from the report, §3.4.4).
 */
export function tokenRejectedEvent(
  rejection: EmittedRejection,
  source: Source = 'control-plane',
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
      ...(rejection.clientIp === '' ? {} : { client_ip: rejection.clientIp }),
      client_network: rejection.network,
      ...(rejection.suppressedCount === undefined
        ? {}
        : { suppressed_count: rejection.suppressedCount }),
      ...(rejection.networksSuppressed === undefined
        ? {}
        : { networks_suppressed: rejection.networksSuppressed }),
    },
    source,
    attestation: 'server',
  };
}

/**
 * db.migration.applied, one per applied migration (SR-29), actor.service = migrator. A migration
 * without a compiled-in checksum is a build error (run pnpm migrations:lock), never 'unknown'.
 */
export function migrationAppliedEvents(
  set: 'cp' | 'audit',
  applied: readonly string[],
  checksums: Readonly<Record<string, string>>,
): StoredEventInput[] {
  return applied.map((migration) => {
    const checksum = checksums[`${set}/${migration}.ts`];
    if (checksum === undefined) {
      throw new Error(`no checksum for migration ${set}/${migration}: run pnpm migrations:lock`);
    }
    return systemEvent({
      action: 'db.migration.applied',
      outcome: 'success',
      service: 'migrator',
      details: { set, migration, checksum },
    });
  });
}
