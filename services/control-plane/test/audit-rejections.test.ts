// auth.token_rejected aggregation (§6.4; SEC-F002-16).
import { describe, expect, it } from 'vitest';
import { type Rejection, createRejectionAggregator, networkOf } from '../src/audit/rejections.js';

const rejection = (clientIp: string, reason = 'expired'): Rejection => ({
  orgId: '0192f0a0-7b3c-7d4e-8f00-00000000000f',
  clientIp,
  reason,
  audience: 'model-gateway',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
});

describe('networkOf', () => {
  it.each([
    ['10.1.2.3', '10.1.2.0/24'],
    ['::ffff:10.1.2.3', '10.1.2.0/24'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['not-an-ip', 'unknown'],
  ])('%s → %s', (ip, network) => {
    expect(networkOf(ip)).toBe(network);
  });
});

describe('rejection aggregator', () => {
  it('writes the first 20 per key and minute, then one summary with suppressed_count', () => {
    let now = 0;
    const emitted: { clientIp: string; suppressedCount?: number }[] = [];
    const agg = createRejectionAggregator({ emit: (r) => emitted.push(r), now: () => now });
    const outcomes = Array.from({ length: 25 }, (_, i) =>
      agg.record(rejection(`10.1.2.${String(i)}`)),
    );
    expect(outcomes.filter((o) => o === 'written')).toHaveLength(20);
    expect(emitted).toHaveLength(20);
    now = 60_000;
    agg.flush();
    expect(emitted).toHaveLength(21);
    expect(emitted[20]).toMatchObject({ suppressedCount: 5, clientIp: '10.1.2.0' });
    // A new window starts fresh.
    expect(agg.record(rejection('10.1.2.99'))).toBe('written');
  });

  it('keys by network, reason and audience', () => {
    const emitted: unknown[] = [];
    const agg = createRejectionAggregator({
      emit: (r) => emitted.push(r),
      perKeyLimit: 1,
      now: () => 0,
    });
    expect(agg.record(rejection('10.1.2.3'))).toBe('written');
    expect(agg.record(rejection('10.1.2.4'))).toBe('suppressed');
    expect(agg.record(rejection('10.1.3.4'))).toBe('written');
    expect(agg.record(rejection('10.1.2.4', 'bad_signature'))).toBe('written');
  });

  it('caps individual events per instance at 600 a minute', () => {
    let written = 0;
    const agg = createRejectionAggregator({ emit: () => written++, now: () => 0 });
    for (let i = 0; i < 700; i++)
      agg.record(rejection(`10.${String(i % 250)}.${String(Math.floor(i / 250))}.1`));
    expect(written).toBe(600);
    agg.flush(true);
    expect(written).toBeGreaterThan(600);
  });
});
