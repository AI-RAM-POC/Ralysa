// auth.token_rejected aggregation (F-002 design §6.4; SEC-F002-16). Per (client /24 or /64,
// reason, audience) the first 20 rejections in a minute are written individually; the rest are
// counted and summarised when the minute closes, with suppressed_count. Recording never waits on
// the audit write: `emit` is fire-and-forget (the caller uses AuditWriter.writeOrSpool).
//
// Bounded output and memory, whatever an attacker spreads across (code review of PR #21):
// - at most `globalLimit` (600) individual events per window per instance;
// - a key bucket exists only for a key that got an individual event, so there are at most 600;
// - once the cap is reached, rejections from keys without a bucket go to ONE overflow bucket
//   per (reason, audience) (at most `maxOverflowKeys`, then a single catch-all), which counts
//   distinct networks up to a cap instead of storing them;
// - at close, per-key summaries go out for the `maxKeySummaries` buckets with the most
//   suppressed rejections; the rest fold into the overflow summaries.
// So a window emits at most globalLimit + maxKeySummaries + maxOverflowKeys + 1 events.
import { isIPv4, isIPv6 } from 'node:net';
import type { Metrics } from '../observability/metrics.js';
import { noopMetrics } from '../observability/metrics.js';

export interface Rejection {
  /**
   * The org the rejection is aggregated under. It MUST come from deployment config
   * (`config.org.id`) or another verified source, never from the `tid` of the token being
   * rejected: that token is unverified, and a caller choosing orgIds could open a fresh set of
   * buckets and overflow keys per value and defeat the output and memory bounds above
   * (code review of PR #21). T07 (control plane) and T11 (packages/auth verifiers) wire it so.
   */
  orgId: string;
  clientIp: string;
  reason: string;
  audience: string;
  traceId: string;
}

export interface EmittedRejection extends Rejection {
  /** The /24 or /64 of the client, or `overflow` for an overflow summary. */
  network: string;
  suppressedCount?: number;
  /** Overflow summaries only: distinct networks folded in (saturates at NETWORK_COUNT_CAP). */
  networksSuppressed?: number;
}

export type RejectionEmit = (rejection: EmittedRejection) => void;

export interface RejectionAggregatorOptions {
  emit: RejectionEmit;
  now?: () => number;
  perKeyLimit?: number;
  globalLimit?: number;
  maxKeySummaries?: number;
  maxOverflowKeys?: number;
  windowMs?: number;
  metrics?: Metrics;
}

export const NETWORK_COUNT_CAP = 1024;

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

interface Overflow {
  first: Rejection;
  suppressed: number;
  /** Distinct networks, kept only until NETWORK_COUNT_CAP (then the count saturates). */
  networks: Set<string>;
}

export interface RejectionAggregator {
  record(rejection: Rejection): 'written' | 'suppressed';
  /**
   * Counts `count` rejections that are known only as a number (a verifying service's reporter
   * dropped them when its buffer was full, T12): they go straight to the overflow summary of
   * their (reason, audience), with network `unknown`.
   */
  recordSuppressed(rejection: Rejection, count: number): void;
  /** Closes the window if it has elapsed (call from a timer, and before shutdown with force). */
  flush(force?: boolean): void;
  /** Live bucket counts (tests and metrics). */
  size(): { keys: number; overflow: number };
}

export function createRejectionAggregator(
  options: RejectionAggregatorOptions,
): RejectionAggregator {
  const now = options.now ?? (() => Date.now());
  const perKey = options.perKeyLimit ?? 20;
  const globalLimit = options.globalLimit ?? 600;
  const maxKeySummaries = options.maxKeySummaries ?? 50;
  const maxOverflowKeys = options.maxOverflowKeys ?? 20;
  const windowMs = options.windowMs ?? 60_000;
  const metrics = options.metrics ?? noopMetrics;
  let windowStart = now();
  let writtenInWindow = 0;
  let buckets = new Map<string, Bucket>();
  let overflow = new Map<string, Overflow>();

  const addOverflow = (rejection: Rejection, network: string, count: number) => {
    let key = `${rejection.orgId}|${rejection.reason}|${rejection.audience}`;
    if (!overflow.has(key) && overflow.size >= maxOverflowKeys) key = `${rejection.orgId}|*`;
    let entry = overflow.get(key);
    if (entry === undefined) {
      entry = { first: rejection, suppressed: 0, networks: new Set() };
      overflow.set(key, entry);
    }
    entry.suppressed += count;
    if (entry.networks.size < NETWORK_COUNT_CAP) entry.networks.add(network);
  };

  const close = () => {
    const suppressedBuckets = [...buckets.values()]
      .filter((b) => b.suppressed > 0)
      .sort((a, b) => b.suppressed - a.suppressed);
    for (const [index, bucket] of suppressedBuckets.entries()) {
      if (index < maxKeySummaries) {
        options.emit({
          ...bucket.first,
          network: bucket.network,
          suppressedCount: bucket.suppressed,
        });
      } else {
        addOverflow(bucket.first, bucket.network, bucket.suppressed);
      }
    }
    for (const entry of overflow.values()) {
      options.emit({
        ...entry.first,
        network: 'overflow',
        suppressedCount: entry.suppressed,
        networksSuppressed: entry.networks.size,
      });
    }
    buckets = new Map();
    overflow = new Map();
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
      const bucket = buckets.get(key);
      const underCap = writtenInWindow < globalLimit;
      if (bucket === undefined && underCap) {
        buckets.set(key, { first: rejection, network, written: 1, suppressed: 0 });
        writtenInWindow++;
        options.emit({ ...rejection, network });
        return 'written';
      }
      if (bucket !== undefined && bucket.written < perKey && underCap) {
        bucket.written++;
        writtenInWindow++;
        options.emit({ ...rejection, network });
        return 'written';
      }
      metrics.increment('audit_rejections_suppressed_total', { reason: rejection.reason });
      if (bucket !== undefined) bucket.suppressed++;
      else addOverflow(rejection, network, 1);
      return 'suppressed';
    },
    recordSuppressed(rejection, count) {
      flush();
      if (!Number.isSafeInteger(count) || count < 1) return;
      metrics.increment('audit_rejections_suppressed_total', { reason: rejection.reason }, count);
      addOverflow(rejection, 'unknown', count);
    },
    flush,
    size: () => ({ keys: buckets.size, overflow: overflow.size }),
  };
}
