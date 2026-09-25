// POST /v1/auth/sign-in-failures (F-002 design §3.4.1; AC-4; [AR-16]; SEC-F002-16, -30). The CLI
// reports flow-A failures that happen at the IdP (declined, expired device code, Conditional
// Access, …), so those attempts are audited too. Unauthenticated, so:
//   - 10 reports per minute per client (/64 for IPv6), beyond the prefix-wide limits; a throttled
//     request (429) is not a sign-in attempt and writes nothing;
//   - idempotent per `attempt_id`: a report seen in the last 10 minutes on this instance answers
//     202 without a second event, and the event id is derived from the attempt id, so a repeat
//     that reaches another replica is stored as a duplicate, not a second event;
//   - at most 60 events per minute for the org, and identical failures from one /24 (IPv4) or /64
//     (IPv6) aggregated past 10 per minute: the rest are summarised once a minute with
//     `suppressed_count` (the auth.token_rejected mechanism, audit/rejections.ts).
// Events: `auth.sign_in outcome=failure`, `attestation=client`, the client's claims under
// `details.client` (sanitised display text) and server facts under `details.server`
// (`reported_by: client`). An expired device code is `expired`; every other IdP error is
// `idp_error` (§5.8).
import { newTraceId, uuidv7 } from '@ralysa/protocol/common';
import { SignInFailureReport } from '@ralysa/protocol/control-plane';
import type { FastifyInstance } from 'fastify';
import type { StoredEventInput } from '../../audit/columns.js';
import { derivedEventId } from '../../audit/events.js';
import { type EmittedRejection, createRejectionAggregator } from '../../audit/rejections.js';
import { ROUTES } from '../../http/contracts.js';
import { HttpProblem } from '../../http/errors.js';
import { clientKey, createRateLimiter } from '../../http/rate-limits.js';
import type { RtsDeps } from '../deps.js';
import { sanitizeDisplayText } from '../display-text.js';

export const REPORTS_PER_CLIENT_PER_MINUTE = 10;
export const REPORT_EVENTS_PER_ORG_PER_MINUTE = 60;
export const IDENTICAL_REPORTS_PER_NETWORK = 10;
const SEEN_TTL_MS = 10 * 60 * 1000;
const SEEN_MAX = 50_000;

/** A stable UUID (version 8) for an attempt's event: per org, per attempt id. */
export function reportEventId(orgId: string, attemptId: string): string {
  return derivedEventId('sign-in-failure', orgId, attemptId);
}

interface Report {
  report: SignInFailureReport;
  traceId: string;
  clientIp: string;
}

export interface SignInFailureAggregator {
  record(input: Report): 'written' | 'suppressed';
  /** Closes the window if it has elapsed (a timer in serve; `force` before shutdown). */
  flush(force?: boolean): void;
}

export function createSignInFailureAggregator(options: {
  emit: (events: StoredEventInput[]) => void;
  orgId: string;
  /** Stamped on every event, like the server's own sign-in events [AR-4]. */
  policyVersion: string;
  now?: () => number;
}): SignInFailureAggregator {
  const { emit, orgId, now } = options;
  // The aggregator emits an individual event synchronously inside record(), so the report being
  // recorded is known then; a per-minute summary carries only its bucket's first facts.
  let current: Report | undefined;
  const event = (rejection: EmittedRejection): StoredEventInput => {
    const summary = rejection.suppressedCount !== undefined;
    const report = summary ? undefined : current?.report;
    const idpErrorCode = sanitizeDisplayText(report?.idp_error_code, 64);
    const deviceLabel = sanitizeDisplayText(report?.device_label, 64);
    return {
      event_id: report === undefined ? uuidv7() : reportEventId(orgId, report.attempt_id),
      action: 'auth.sign_in',
      actor: { type: 'user', user_id: null, idp_subject: null, service: null },
      outcome: 'failure',
      reason_code: rejection.reason === 'expired_token' ? 'expired' : 'idp_error',
      surface: 'cli',
      trace_id: rejection.traceId,
      policy_version: options.policyVersion,
      details: {
        server: {
          reported_by: 'client',
          flow: 'idp_device',
          client_ip: rejection.clientIp,
          network: rejection.network,
          ...(report === undefined ? {} : { attempt_id: report.attempt_id }),
          ...(summary
            ? {
                suppressed_count: rejection.suppressedCount ?? 0,
                ...(rejection.networksSuppressed === undefined
                  ? {}
                  : { networks_suppressed: rejection.networksSuppressed }),
              }
            : {}),
        },
        client: {
          error: rejection.reason,
          ...(idpErrorCode === undefined ? {} : { idp_error_code: idpErrorCode }),
          ...(deviceLabel === undefined ? {} : { device_label: deviceLabel }),
        },
      },
      source: 'control-plane',
      attestation: 'client',
    };
  };
  const aggregator = createRejectionAggregator({
    emit: (rejection) => {
      emit([event(rejection)]);
    },
    perKeyLimit: IDENTICAL_REPORTS_PER_NETWORK,
    globalLimit: REPORT_EVENTS_PER_ORG_PER_MINUTE,
    ...(now === undefined ? {} : { now }),
  });
  return {
    record(input) {
      current = input;
      try {
        return aggregator.record({
          orgId,
          clientIp: input.clientIp,
          reason: input.report.error,
          audience: 'idp_device',
          traceId: input.traceId,
        });
      } finally {
        current = undefined;
      }
    },
    flush: (force) => {
      aggregator.flush(force);
    },
  };
}

export function registerSignInFailures(
  app: FastifyInstance,
  deps: RtsDeps,
  aggregator: SignInFailureAggregator,
): void {
  const now = deps.now ?? (() => Date.now());
  const limiter = createRateLimiter({
    perIpPerMinute: REPORTS_PER_CLIENT_PER_MINUTE,
    // The prefix-wide global limit applies as well; this one only bounds a single client.
    globalPerMinute: Number.MAX_SAFE_INTEGER,
    now,
  });
  const seen = new Map<string, number>();

  app.post(ROUTES.signInFailures.url, async (request, reply) => {
    const retry = limiter.take(clientKey(request.ip));
    if (retry > 0) {
      throw new HttpProblem('rate_limited', undefined, {
        headers: { 'retry-after': String(retry) },
      });
    }
    const parsed = SignInFailureReport.safeParse(request.body);
    if (!parsed.success) throw new HttpProblem('invalid_request');
    const report = parsed.data;
    const t = now();
    // Oldest first (insertion order): drop the expired, and the oldest past the bound.
    for (const [id, until] of seen) {
      if (until > t && seen.size <= SEEN_MAX) break;
      seen.delete(id);
    }
    if (seen.has(report.attempt_id)) return reply.status(202).send({});
    seen.set(report.attempt_id, t + SEEN_TTL_MS);
    aggregator.record({
      report,
      clientIp: request.ip,
      traceId: request.traceId === '' ? newTraceId() : request.traceId,
    });
    return reply.status(202).send({});
  });
}
