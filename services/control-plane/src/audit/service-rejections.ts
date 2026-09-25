// auth.token_rejected reports from verifying services (F-002 design §5.5, §6.4; SEC-F002-16;
// T11-2). A gateway's `onReject` reaches the control plane through the service path
// (POST /v1/audit/events, `@ralysa/auth`'s rejection reporter), and the reports are aggregated
// here, server-side, because the /24 and /64 networks need node:net:
//
// - one aggregator per reporting service, so each verifier has its own cap of 600 events a minute
//   and its own buckets; one service's flood can't use up another's budget;
// - per (client /24 or /64, reason, audience) the first 20 a minute are written individually,
//   the rest summarised with `suppressed_count`; rejections the reporter had to drop arrive as a
//   count and go to the overflow summary;
// - the org is the service token's (the verifier pins it to config), never a report field (OI-4);
// - `source` is the reporting service, from its token;
// - writing never blocks the report: events go through AuditWriter.writeOrSpool, fire-and-forget;
// - a report whose event_id was seen in the last 10 minutes on this instance is a `duplicate` (a
//   reporter retrying a batch whose answer it lost), so it isn't counted twice.
import type { Source } from '@ralysa/protocol/audit';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import { tokenRejectedEvent } from './events.js';
import { type RejectionAggregator, createRejectionAggregator } from './rejections.js';
import type { AuditWriter } from './writer.js';

export interface ServiceRejectionReport {
  /** The report's own event id (its reporter's retry key). */
  eventId: string;
  /** The reporting service (from its token). */
  service: string;
  source: Source;
  orgId: string;
  reason: string;
  audience: string;
  /** '' when the service didn't know it (network `unknown`). */
  clientIp: string;
  traceId: string;
  /** Present when the service's reporter dropped this many identical rejections. */
  droppedCount?: number;
}

export interface ServiceRejections {
  record(report: ServiceRejectionReport): 'written' | 'suppressed' | 'duplicate';
  /** Closes elapsed windows (a timer in serve; `force` before shutdown). */
  flush(force?: boolean): void;
}

const SEEN_TTL_MS = 10 * 60 * 1000;
const SEEN_MAX = 50_000;

export function createServiceRejections(options: {
  writer: AuditWriter;
  logger: Logger;
  metrics?: Metrics;
  now?: () => number;
}): ServiceRejections {
  const now = options.now ?? (() => Date.now());
  const aggregators = new Map<string, RejectionAggregator>();
  const seen = new Map<string, number>();
  const firstSeen = (eventId: string): boolean => {
    const t = now();
    // Oldest first (insertion order): drop the expired, and the oldest past the bound.
    for (const [id, until] of seen) {
      if (until > t && seen.size < SEEN_MAX) break;
      seen.delete(id);
    }
    if (seen.has(eventId)) return false;
    seen.set(eventId, t + SEEN_TTL_MS);
    return true;
  };
  const aggregatorFor = (report: ServiceRejectionReport): RejectionAggregator => {
    let aggregator = aggregators.get(report.service);
    if (aggregator === undefined) {
      const { source, orgId } = report;
      aggregator = createRejectionAggregator({
        emit: (rejection) =>
          void options.writer
            .writeOrSpool(orgId, [tokenRejectedEvent(rejection, source)])
            .catch((error: unknown) => {
              options.logger.warn('token_rejected_write_failed', {
                service: report.service,
                error: String(error),
              });
            }),
        ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
        now,
      });
      // Bounded: services come from the static registry (config), never from a request.
      aggregators.set(report.service, aggregator);
    }
    return aggregator;
  };
  return {
    record(report) {
      if (!firstSeen(report.eventId)) return 'duplicate';
      const aggregator = aggregatorFor(report);
      const rejection = {
        orgId: report.orgId,
        clientIp: report.clientIp,
        reason: report.reason,
        audience: report.audience,
        traceId: report.traceId,
      };
      if (report.droppedCount !== undefined) {
        aggregator.recordSuppressed(rejection, report.droppedCount);
        return 'suppressed';
      }
      return aggregator.record(rejection);
    },
    flush(force) {
      for (const aggregator of aggregators.values()) aggregator.flush(force);
    },
  };
}
