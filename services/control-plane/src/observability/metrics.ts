// Minimal metrics port (F-002 design §5.8, §6.4). The audit core emits through it; F-002-T07 binds
// it to the service's exporter. Names are the design's alert inputs:
//   audit_write_failures_total, audit_spooled_total, audit_spool_lost_total,
//   audit_seal_lag_seconds, audit_seal_late_total, audit_rejections_suppressed_total.
export type Labels = Readonly<Record<string, string>>;

export interface Metrics {
  increment(name: string, labels?: Labels, by?: number): void;
  gauge(name: string, value: number, labels?: Labels): void;
}

export const noopMetrics: Metrics = {
  increment: () => undefined,
  gauge: () => undefined,
};

export interface MemoryMetrics extends Metrics {
  counter(name: string, labels?: Labels): number;
  lastGauge(name: string, labels?: Labels): number | undefined;
}

const key = (name: string, labels: Labels = {}): string =>
  `${name}{${Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',')}}`;

/** For tests and local runs. */
export function createMemoryMetrics(): MemoryMetrics {
  const counters = new Map<string, number>();
  const gauges = new Map<string, number>();
  return {
    increment(name, labels, by = 1) {
      const k = key(name, labels);
      counters.set(k, (counters.get(k) ?? 0) + by);
    },
    gauge(name, value, labels) {
      gauges.set(key(name, labels), value);
    },
    counter: (name, labels) => counters.get(key(name, labels)) ?? 0,
    lastGauge: (name, labels) => gauges.get(key(name, labels)),
  };
}
