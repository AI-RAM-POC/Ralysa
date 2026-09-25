// auth.token_rejected aggregation (F-002 design §6.4; SEC-F002-16). Per (client /24 or /64,
// reason, audience) the first 20 rejections in a minute are written individually; the rest are
// counted and written as ONE event per key when the minute closes, with suppressed_count. Each
// instance also caps itself at 600 individual events per minute. Recording never waits on the
// audit write: `emit` is fire-and-forget (the caller uses AuditWriter.writeOrSpool).
import { isIPv4, isIPv6 } from 'node:net';
import type { Metrics } from '../observability/metrics.js';
import { noopMetrics } from '../observability/metrics.js';

export interface Rejection {
  orgId: string;
  clientIp: string;
  reason: string;
  audience: string;
  traceId: string;
}

export interface RejectionEmit {
  (rejection: Rejection & { network: string; suppressedCount?: number }): void;
}

export interface RejectionAggregatorOptions {
  emit: RejectionEmit;
  now?: () => number;
  perKeyLimit?: number;
  globalLimit?: number;
  windowMs?: number;
  metrics?: Metrics;
}

/** The /24 (IPv4) or /64 (IPv6) network of an address; anything else is "unknown". */
export function networkOf(ip: string): string {
  const v4 = ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (isIPv4(v4)) return `${v4.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIPv6(ip)) {
    const [head = '', tail = ''] = ip.split('::');
    const left = head === '' ? [] : head.split(':');
    const right = tail === '' ? [] : tail.split(':');
    const full = ip.includes('::')
      ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
      : left;
    return `${full
      .slice(0, 4)
      .map((group) => Number.parseInt(group, 16).toString(16))
      .join(':')}::/64`;
  }
  return 'unknown';
}

interface Bucket {
  first: Rejection;
  network: string;
  written: number;
  suppressed: number;
}

export interface RejectionAggregator {
  record(rejection: Rejection): 'written' | 'suppressed';
  /** Closes the window if it has elapsed (call from a timer, and before shutdown with force). */
  flush(force?: boolean): void;
}

export function createRejectionAggregator(
  options: RejectionAggregatorOptions,
): RejectionAggregator {
  const now = options.now ?? (() => Date.now());
  const perKey = options.perKeyLimit ?? 20;
  const globalLimit = options.globalLimit ?? 600;
  const windowMs = options.windowMs ?? 60_000;
  const metrics = options.metrics ?? noopMetrics;
  let windowStart = now();
  let writtenInWindow = 0;
  let buckets = new Map<string, Bucket>();

  const close = () => {
    for (const bucket of buckets.values()) {
      if (bucket.suppressed > 0) {
        options.emit({
          ...bucket.first,
          network: bucket.network,
          suppressedCount: bucket.suppressed,
        });
      }
    }
    buckets = new Map();
    writtenInWindow = 0;
    windowStart = now();
  };

  const flush = (force = false) => {
    if (force || now() - windowStart >= windowMs) close();
  };

  return {
    record(rejection) {
      flush();
      const network = networkOf(rejection.clientIp);
      const key = `${rejection.orgId}|${network}|${rejection.reason}|${rejection.audience}`;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { first: rejection, network, written: 0, suppressed: 0 };
        buckets.set(key, bucket);
      }
      if (bucket.written < perKey && writtenInWindow < globalLimit) {
        bucket.written++;
        writtenInWindow++;
        options.emit({ ...rejection, network });
        return 'written';
      }
      bucket.suppressed++;
      metrics.increment('audit_rejections_suppressed_total', { reason: rejection.reason });
      return 'suppressed';
    },
    flush,
  };
}
