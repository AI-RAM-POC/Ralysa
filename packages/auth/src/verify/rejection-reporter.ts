// Reporting a verifier's rejections as `auth.token_rejected` (F-002 design §5.5, §6.4;
// SEC-F002-16; T11-2, landed with F-002-T12). A PEP wires `record` into the verifier's
// `onReject`; the reporter queues and sends them to the control plane's service path
// (`POST /v1/audit/events`, with the service's own token), where they are aggregated per client
// /24 or /64, reason and audience before they are stored (the aggregation needs node:net, so it
// stays server-side).
//
// - `record` never throws and never waits: a rejection is never blocked on its audit write.
// - The queue is bounded (`maxQueue`, default 1,000). A rejection that doesn't fit is counted per
//   reason, and the count is sent as one report with `dropped_count` (no client address), so
//   every rejection is either reported or counted.
// - Every `flushMs` (default 1 s) the queue is sent in batches of up to 100, one batch at a time.
//   A batch that fails for a reason a retry can fix (no answer, 401, 429, 5xx, no service token)
//   stays queued with the same event ids; the control plane answers a repeated id as
//   `duplicate`, so a retry after a lost answer is not counted twice. A batch the control plane
//   refuses outright (403: `auth.token_rejected` isn't allow-listed for this service; 413, 422)
//   is dropped and reported through `onError`, since resending it can't succeed.
// - Nothing sent carries the token: only the reason, the audience, the caller's address and the
//   trace id.
import { type Audience, type TokenRejectReason } from '@ralysa/protocol/auth';
import { newTraceId, uuidv7 } from '@ralysa/protocol/common';
import { type HttpOptions, request } from '../http.js';
import { startTimer } from '../platform.js';
import type { ServiceTokenSource } from '../service/service-token-source.js';
import type { RejectInfo } from './access-token-verifier.js';

export interface RejectionReporterOptions extends HttpOptions {
  /** `<control plane>/v1/audit/events` */
  url: string;
  serviceTokens: ServiceTokenSource;
  /** This PEP's audience, reported with every rejection. */
  audience: Audience;
  /** Default 1000. */
  flushMs?: number;
  /** Default 1000. */
  maxQueue?: number;
  /** Default 100 (the service path's batch limit). */
  batchSize?: number;
  /** A batch the control plane refused for good, or a reporting fault (never contains a token). */
  onError?: (error: Error) => void;
}

export interface RejectionReporter {
  /** For the verifier's `onReject`: queues the rejection; never throws, never waits. */
  record(rejection: RejectInfo): void;
  /** Sends what is queued now (single flight). Never throws. */
  flush(): Promise<void>;
  /** Flushes every `flushMs` until `stop()`. */
  start(): void;
  stop(): void;
  status(): { queued: number; dropped: number };
}

interface Queued {
  eventId: string;
  reason: TokenRejectReason;
  clientIp?: string;
  traceId: string;
  droppedCount?: number;
}

const TRACE_ID = /^[0-9a-f]{32}$/;
/** An address as a PEP sees it (IPv4, IPv6, IPv4-mapped); anything else is left out. */
const CLIENT_IP = /^[0-9A-Fa-f:.]{2,45}$/;

export function createRejectionReporter(opts: RejectionReporterOptions): RejectionReporter {
  if (!/^https?:\/\/[^\s?#]+$/.test(opts.url)) {
    throw new Error('reporter url must be a plain http(s) URL');
  }
  const maxQueue = opts.maxQueue ?? 1_000;
  const batchSize = Math.min(opts.batchSize ?? 100, 100);
  const flushMs = opts.flushMs ?? 1_000;
  const queue: Queued[] = [];
  const dropped = new Map<TokenRejectReason, number>();
  let inflight: Promise<void> | undefined;
  let stopTimer: (() => void) | undefined;
  let running = false;

  const report = (error: Error) => {
    try {
      opts.onError?.(error);
    } catch {
      // A failing error sink changes nothing.
    }
  };

  const toEvent = (item: Queued) => ({
    event_id: item.eventId,
    action: 'auth.token_rejected',
    actor: { type: 'user', user_id: null, idp_subject: null, service: null },
    outcome: 'denied',
    reason_code: item.reason,
    trace_id: item.traceId,
    details: {
      audience: opts.audience,
      reason: item.reason,
      ...(item.clientIp === undefined ? {} : { client_ip: item.clientIp }),
      ...(item.droppedCount === undefined ? {} : { dropped_count: item.droppedCount }),
    },
  });

  const send = async (): Promise<void> => {
    // Counted drops go first: they are few (one per reason) and never dropped themselves.
    for (const [reason, count] of dropped) {
      queue.unshift({ eventId: uuidv7(), reason, traceId: newTraceId(), droppedCount: count });
    }
    dropped.clear();
    while (queue.length > 0) {
      const batch = queue.slice(0, batchSize);
      let status: number;
      try {
        const token = await opts.serviceTokens.getToken();
        ({ status } = await request(opts, 'POST', opts.url, {
          json: { events: batch.map(toEvent) },
          bearer: token,
          what: 'rejection report',
        }));
      } catch (error) {
        report(error instanceof Error ? error : new Error('rejection report failed'));
        return; // kept; retried on the next flush
      }
      if (status === 201) {
        queue.splice(0, batch.length);
        continue;
      }
      if (status === 403 || status === 413 || status === 422 || status === 400) {
        queue.splice(0, batch.length);
        report(new Error(`rejection report refused by the control plane (${String(status)})`));
        continue;
      }
      report(new Error(`rejection report not accepted (${String(status)}); will retry`));
      return;
    }
  };

  const flush = (): Promise<void> => {
    inflight ??= send()
      .catch(() => undefined)
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };

  const loop = () => {
    stopTimer = startTimer(() => {
      void flush().finally(() => {
        if (running) loop();
      });
    }, flushMs);
  };

  return {
    record(rejection) {
      try {
        if (queue.length >= maxQueue) {
          dropped.set(rejection.reason, (dropped.get(rejection.reason) ?? 0) + 1);
          return;
        }
        const clientIp =
          rejection.clientIp !== undefined && CLIENT_IP.test(rejection.clientIp)
            ? rejection.clientIp
            : undefined;
        queue.push({
          eventId: uuidv7(),
          reason: rejection.reason,
          ...(clientIp === undefined ? {} : { clientIp }),
          traceId:
            rejection.traceId !== undefined && TRACE_ID.test(rejection.traceId)
              ? rejection.traceId
              : newTraceId(),
        });
      } catch {
        // Recording a rejection never changes the answer.
      }
    },
    flush,
    start() {
      if (running) return;
      running = true;
      loop();
    },
    stop() {
      running = false;
      stopTimer?.();
      stopTimer = undefined;
    },
    status: () => ({
      queued: queue.length,
      dropped: [...dropped.values()].reduce((sum, n) => sum + n, 0),
    }),
  };
}
