// POST /v1/audit/events: the service ingestion path (F-002 design §3.4.4, §5.5; AC-11; [AR-8];
// SEC-F002-03, -16, -23; D-35). The only audit write path for services: no service holds a
// database writer role.
//
//   service token (registered client) → 1–100 events, 256 KB → the per-service allow-list →
//   per-event validation (the envelope, I-JSON details [AR-5], `failure` on auth.* only [AR-3]) →
//   user actors exist in the org → a plain INSERT per event in a savepoint (23505 = duplicate),
//   fail closed in 250 ms → 201 with a status per event.
//
// The server sets `source` from the service token (never the body), `attestation = server`,
// `org_id` from the token (pinned to config) and `ts` from the database clock. A user token or an
// unregistered service is 403 (recorded as auth.token_rejected wrong_token_use). An action outside
// the service's allow-list rejects the whole batch with 403 and writes one `audit.ingest_rejected`
// per disallowed action, before answering; that denial stands even if its own write fails
// (ADR-0022 rule 5), so it goes through writeOrSpool.
//
// auth.token_rejected reports (a gateway's verifier rejections, T11-2) are not inserted as sent:
// they go to the per-service rejection aggregator (service-rejections.ts) and are answered
// `aggregated`, or `duplicate` for a report id seen in the last 10 minutes.
import { isIP } from 'node:net';
import type { AuditEventInput } from '@ralysa/protocol/audit';
import { uuidv7 } from '@ralysa/protocol/common';
import { ServiceEventsRequest, TokenRejectedReportDetails } from '@ralysa/protocol/control-plane';
import type { VerifiedService } from '@ralysa/auth';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withOrg } from '../../db/kysely.js';
import type { RtsDeps } from '../../auth/deps.js';
import { authenticate } from '../../auth/route-auth.js';
import { ROUTES } from '../../http/contracts.js';
import { HttpProblem } from '../../http/errors.js';
import { disallowedActions, sourceForService } from '../action-allowlist.js';
import type { StoredEventInput } from '../columns.js';
import {
  AuditUnavailableError,
  InvalidAuditEventError,
  type WriteResult,
  validateStoredEvent,
} from '../writer.js';

type ServiceStatus = WriteResult['status'] | 'aggregated';

/** audit.ingest_rejected (§3.5): the calling service and the action it may not write. */
function ingestRejectedEvent(
  request: FastifyRequest,
  service: string,
  action: string,
  reason: 'action_not_allowed' | 'no_audit_source',
): StoredEventInput {
  return {
    event_id: uuidv7(),
    action: 'audit.ingest_rejected',
    actor: { type: 'service', user_id: null, idp_subject: null, service },
    outcome: 'denied',
    reason_code: reason,
    trace_id: request.traceId,
    details: { service, action },
    source: 'control-plane',
    attestation: 'server',
  };
}

async function refuseBatch(
  deps: RtsDeps,
  request: FastifyRequest,
  caller: VerifiedService,
  actions: readonly string[],
  reason: 'action_not_allowed' | 'no_audit_source',
): Promise<never> {
  const events = actions.map((action) =>
    ingestRejectedEvent(request, caller.service, action, reason),
  );
  try {
    await deps.writer.writeOrSpool(caller.orgId, events);
  } catch (error) {
    deps.logger.warn('ingest_rejected_write_failed', {
      service: caller.service,
      error: String(error),
    });
  }
  throw new HttpProblem('forbidden');
}

/** The user ids in `events` that don't exist in the org (§3.4.4: existence, not provenance). */
async function unknownUsers(deps: RtsDeps, orgId: string, events: readonly AuditEventInput[]) {
  const ids = [
    ...new Set(events.flatMap((e) => (e.actor.user_id === null ? [] : [e.actor.user_id]))),
  ];
  if (ids.length === 0) return [];
  const found = await withOrg(
    deps.db,
    orgId,
    async (trx) => trx.selectFrom('cp.app_user').select('id').where('id', 'in', ids).execute(),
    { readOnly: true },
  );
  const known = new Set(found.map((row) => row.id));
  return ids.filter((id) => !known.has(id));
}

export function registerServiceEvents(app: FastifyInstance, deps: RtsDeps): void {
  app.post(
    ROUTES.serviceEvents.url,
    { schema: { response: { 201: ROUTES.serviceEvents.responses[201].schema } } },
    async (request, reply) => {
      const caller = await authenticate(deps, request, 'service', {
        forbidden: ['wrong_token_use'],
      });
      const client = deps.clients.service(caller.clientId);
      if (client === undefined) throw new HttpProblem('forbidden');

      const parsed = ServiceEventsRequest.safeParse(request.body);
      if (!parsed.success) throw new HttpProblem('unprocessable');
      const events = parsed.data.events;
      const actions = events.map((e) => e.action);

      const source = sourceForService(client.name);
      if (source === undefined) {
        return refuseBatch(deps, request, caller, [...new Set(actions)], 'no_audit_source');
      }
      const disallowed = disallowedActions(client, actions);
      if (disallowed.length > 0) {
        return refuseBatch(deps, request, caller, disallowed, 'action_not_allowed');
      }

      const stored: StoredEventInput[] = [];
      const reports: { event: AuditEventInput; details: TokenRejectedReportDetails }[] = [];
      for (const event of events) {
        // A service may speak for a user it serves or for itself, never for another service
        // or as the system (review of #33, R33-7).
        if (
          event.actor.type === 'system' ||
          (event.actor.type === 'service' && event.actor.service !== client.name)
        ) {
          throw new HttpProblem('unprocessable');
        }
        const candidate: StoredEventInput = { ...event, source, attestation: 'server' };
        try {
          validateStoredEvent(candidate);
        } catch (error) {
          if (error instanceof InvalidAuditEventError) throw new HttpProblem('unprocessable');
          throw error;
        }
        if (event.action === 'auth.token_rejected') {
          const details = TokenRejectedReportDetails.safeParse(event.details);
          if (!details.success) throw new HttpProblem('unprocessable');
          reports.push({ event, details: details.data });
        } else {
          stored.push(candidate);
        }
      }
      if ((await unknownUsers(deps, caller.orgId, events)).length > 0) {
        throw new HttpProblem('unprocessable');
      }

      let written: WriteResult[];
      try {
        written = await deps.writer.write(caller.orgId, stored);
      } catch (error) {
        if (error instanceof AuditUnavailableError) throw new HttpProblem('audit_unavailable');
        throw error;
      }
      const status = new Map<string, ServiceStatus>(written.map((r) => [r.event_id, r.status]));
      // Rejection reports only once the batch is accepted: never blocked on their own write.
      for (const { event, details } of reports) {
        const result = deps.serviceRejections.record({
          eventId: event.event_id,
          service: client.name,
          source,
          orgId: caller.orgId,
          reason: details.reason,
          audience: details.audience,
          // Not an address (untrusted text from the service) → network `unknown`.
          clientIp:
            details.client_ip !== undefined && isIP(details.client_ip) !== 0
              ? details.client_ip
              : '',
          traceId: event.trace_id,
          ...(details.dropped_count === undefined ? {} : { droppedCount: details.dropped_count }),
        });
        status.set(event.event_id, result === 'duplicate' ? 'duplicate' : 'aggregated');
      }
      return reply.status(201).send({
        results: events.map((e) => ({
          event_id: e.event_id,
          status: status.get(e.event_id) ?? 'duplicate',
        })),
      });
    },
  );
}
