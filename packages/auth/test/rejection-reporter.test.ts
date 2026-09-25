// createRejectionReporter (F-002 design §5.5, §6.4; SEC-F002-16; T11-2): a verifier's rejections
// reach the control plane's service path as auth.token_rejected reports; recording never
// throws or waits, the queue is bounded with drops counted, retryable failures keep the batch
// (same event ids), and refusals drop it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRejectionReporter } from '../src/index.js';
import { type RecordedRequest, fakeFetch } from './support.js';

const URL = 'https://cp.internal/v1/audit/events';
const TOKEN = 'svc-token-for-tests';
const TRACE = 'a'.repeat(32);

interface Sent {
  events: {
    event_id: string;
    action: string;
    outcome: string;
    reason_code: string;
    trace_id: string;
    actor: Record<string, unknown>;
    details: Record<string, unknown>;
  }[];
}
const sentOf = (r: RecordedRequest): Sent => JSON.parse(r.body ?? '{}') as Sent;

function setUp(answer: (n: number) => number = () => 201, maxQueue?: number) {
  let n = 0;
  const fetch = fakeFetch({
    [`POST ${URL}`]: () => ({ status: answer(++n), body: {} }),
  });
  const errors: Error[] = [];
  const reporter = createRejectionReporter({
    url: URL,
    serviceTokens: { getToken: () => Promise.resolve(TOKEN) },
    audience: 'model-gateway',
    fetch,
    onError: (e) => errors.push(e),
    ...(maxQueue === undefined ? {} : { maxQueue }),
  });
  return { reporter, fetch, errors, calls: () => fetch.calls(`POST ${URL}`) };
}

describe('createRejectionReporter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends queued rejections as auth.token_rejected reports with the service token', async () => {
    const { reporter, calls } = setUp();
    reporter.record({ reason: 'expired', clientIp: '203.0.113.9', traceId: TRACE });
    reporter.record({ reason: 'bad_signature', clientIp: '2001:db8::7' });
    expect(reporter.status()).toEqual({ queued: 2, dropped: 0 });
    await reporter.flush();
    expect(calls()).toHaveLength(1);
    const request = calls()[0];
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const { events } = sentOf(request as RecordedRequest);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      action: 'auth.token_rejected',
      outcome: 'denied',
      reason_code: 'expired',
      trace_id: TRACE,
      actor: { type: 'user', user_id: null, idp_subject: null, service: null },
      details: { audience: 'model-gateway', reason: 'expired', client_ip: '203.0.113.9' },
    });
    expect(events[1]?.details).toMatchObject({ client_ip: '2001:db8::7' });
    // A missing trace id is replaced by a fresh one.
    expect(events[1]?.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(reporter.status()).toEqual({ queued: 0, dropped: 0 });
  });

  it('never throws on odd input; an address that is not an IP is left out', async () => {
    const { reporter, calls } = setUp();
    expect(() => {
      reporter.record({ reason: 'malformed', clientIp: '<script>', traceId: 'not-hex' });
    }).not.toThrow();
    await reporter.flush();
    const [event] = sentOf(calls()[0] as RecordedRequest).events;
    expect(event?.details).toEqual({ audience: 'model-gateway', reason: 'malformed' });
    expect(event?.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('sends at most 100 per request', async () => {
    const { reporter, calls } = setUp();
    for (let i = 0; i < 250; i++) reporter.record({ reason: 'expired', clientIp: '10.0.0.1' });
    await reporter.flush();
    expect(calls().map((c) => sentOf(c).events.length)).toEqual([100, 100, 50]);
  });

  it('keeps a batch the control plane could not take, and resends the same event ids', async () => {
    const { reporter, calls, errors } = setUp((n) => (n === 1 ? 503 : 201));
    reporter.record({ reason: 'expired', clientIp: '10.0.0.1' });
    await reporter.flush();
    expect(reporter.status().queued).toBe(1);
    expect(errors).toHaveLength(1);
    await reporter.flush();
    expect(reporter.status().queued).toBe(0);
    const [first, second] = calls().map((c) => sentOf(c).events[0]?.event_id);
    expect(second).toBe(first);
  });

  it('drops a batch the control plane refuses for good (403, 422), and says so', async () => {
    const { reporter, errors } = setUp((n) => (n === 1 ? 403 : 422));
    reporter.record({ reason: 'expired' });
    await reporter.flush();
    reporter.record({ reason: 'expired' });
    await reporter.flush();
    expect(reporter.status().queued).toBe(0);
    expect(errors.map((e) => e.message)).toEqual([
      'rejection report refused by the control plane (403)',
      'rejection report refused by the control plane (422)',
    ]);
  });

  it('keeps the batch when no service token is available', async () => {
    const fetch = fakeFetch({ [`POST ${URL}`]: () => ({ status: 201, body: {} }) });
    const reporter = createRejectionReporter({
      url: URL,
      serviceTokens: { getToken: () => Promise.reject(new Error('no token')) },
      audience: 'model-gateway',
      fetch,
    });
    reporter.record({ reason: 'expired' });
    await reporter.flush();
    expect(reporter.status().queued).toBe(1);
    expect(fetch.requests).toHaveLength(0);
  });

  it('counts what the full queue cannot take and reports it as dropped_count', async () => {
    const { reporter, calls } = setUp(() => 201, 3);
    for (let i = 0; i < 3; i++) reporter.record({ reason: 'expired', clientIp: '10.0.0.1' });
    reporter.record({ reason: 'expired', clientIp: '10.0.0.2' });
    reporter.record({ reason: 'expired' });
    reporter.record({ reason: 'bad_signature' });
    expect(reporter.status()).toEqual({ queued: 3, dropped: 3 });
    await reporter.flush();
    const events = calls().flatMap((c) => sentOf(c).events);
    const counted = events.filter((e) => e.details.dropped_count !== undefined);
    expect(
      counted.map((e) => [e.reason_code, e.details.dropped_count, e.details.client_ip]),
    ).toEqual(
      expect.arrayContaining([
        ['expired', 2, undefined],
        ['bad_signature', 1, undefined],
      ]),
    );
    expect(events).toHaveLength(5);
    expect(reporter.status()).toEqual({ queued: 0, dropped: 0 });
  });

  it('flush is single flight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetch = fakeFetch({
      [`POST ${URL}`]: async () => {
        await gate;
        return { status: 201, body: {} };
      },
    });
    const reporter = createRejectionReporter({
      url: URL,
      serviceTokens: { getToken: () => Promise.resolve(TOKEN) },
      audience: 'model-gateway',
      fetch,
    });
    reporter.record({ reason: 'expired' });
    const a = reporter.flush();
    const b = reporter.flush();
    release();
    await Promise.all([a, b]);
    expect(fetch.requests).toHaveLength(1);
  });

  it('start() flushes every flushMs until stop()', async () => {
    vi.useFakeTimers();
    const { reporter, calls } = setUp();
    reporter.start();
    reporter.record({ reason: 'expired' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls()).toHaveLength(1);
    reporter.record({ reason: 'expired' });
    reporter.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls()).toHaveLength(1);
  });

  it('refuses a URL that is not plain http(s)', () => {
    expect(() =>
      createRejectionReporter({
        url: 'ftp://cp/v1/audit/events',
        serviceTokens: { getToken: () => Promise.resolve(TOKEN) },
        audience: 'model-gateway',
      }),
    ).toThrow();
  });
});
