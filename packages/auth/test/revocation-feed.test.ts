// TC-F-002-11 (feed part): G-1 staleness after 60 s; a replayed or stale feed answer (old
// `issued_at`, lower `epoch`) is not a confirmation [SEC-F002-18 a]; overlap de-duplication
// (the cursor lags issued_at, T08-1); kill switches only from confirmations.
import type { GovernanceState } from '@ralysa/protocol/control-plane';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PollOutcome, type ServiceTokenSource, createRevocationFeed } from '../src/index.js';
import { SID, USER, clock, fakeFetch } from './support.js';

const FEED = 'https://cp.internal/v1/internal/governance';
const tokens: ServiceTokenSource = { getToken: () => Promise.resolve('svc-token') };
const OTHER_SID = '0192f0a0-7b3c-7d4e-8f00-0000000000b2';

describe('createRevocationFeed', () => {
  const c = clock(Date.parse('2026-09-25T10:00:00.000Z'));
  let answer: () => { status: number; body?: unknown };
  let feedFetch: ReturnType<typeof fakeFetch>;
  const state = (over: Partial<GovernanceState> = {}): GovernanceState => ({
    epoch: 10,
    issued_at: new Date(c.now()).toISOString(),
    cursor: new Date(c.now() - 60_000).toISOString(),
    revoked_sessions: [],
    users_revoked_before: [],
    kill_switches: [],
    ...over,
  });
  const feed = (onPoll?: (o: PollOutcome) => void) =>
    createRevocationFeed({
      url: FEED,
      serviceTokens: tokens,
      fetch: feedFetch,
      now: c.now,
      ...(onPoll === undefined ? {} : { onPoll }),
    });
  const iat = () => Math.floor(c.now() / 1000);

  beforeEach(() => {
    c.set(Date.parse('2026-09-25T10:00:00.000Z'));
    answer = () => ({ status: 200, body: state() });
    feedFetch = fakeFetch({ [`GET ${FEED}`]: () => answer() });
  });

  it('is stale until the first confirmation, then fresh; stale again after 60 s without one (G-1)', async () => {
    const f = feed();
    expect(f.check({ sid: SID, sub: USER, iat: iat() })).toBe('governance_stale');
    expect(await f.pollOnce()).toBe('confirmed');
    expect(f.check({ sid: SID, sub: USER, iat: iat() })).toBe('ok');
    expect(feedFetch.requests[0]?.headers.authorization).toBe('Bearer svc-token');

    answer = () => ({ status: 503, body: {} });
    c.advance(59_000);
    expect(await f.pollOnce()).toBe('unavailable');
    expect(f.check({ sid: SID, sub: USER, iat: iat() })).toBe('ok');
    c.advance(1_001);
    expect(f.check({ sid: SID, sub: USER, iat: iat() })).toBe('governance_stale');
    expect(f.status().stale).toBe(true);
  });

  it('G-1 counts from issued_at: a 29 s old answer keeps the PEP fresh for 31 s more, not 60 s', async () => {
    const f = feed();
    answer = () => ({
      status: 200,
      body: state({ issued_at: new Date(c.now() - 29_000).toISOString() }),
    });
    expect(await f.pollOnce()).toBe('confirmed');
    expect(f.status().confirmedAt).toBe(c.now() - 29_000);
    answer = () => ({ status: 503, body: {} });
    c.advance(31_000);
    expect(f.check({ sid: SID, sub: USER, iat: iat() })).toBe('ok');
    c.advance(1);
    expect(f.check({ sid: SID, sub: USER, iat: iat() })).toBe('governance_stale');
    // An issued_at slightly ahead of our clock (DB clock skew) is credited as now, not later.
    answer = () => ({
      status: 200,
      body: state({ issued_at: new Date(c.now() + 10_000).toISOString() }),
    });
    expect(await f.pollOnce()).toBe('confirmed');
    expect(f.status().confirmedAt).toBe(c.now());
  });

  it('an answer whose issued_at is more than 30 s off our clock is no confirmation (replayed or cached)', async () => {
    const f = feed();
    const replayed = state({ issued_at: new Date(c.now() - 31_000).toISOString() });
    answer = () => ({ status: 200, body: replayed });
    expect(await f.pollOnce()).toBe('stale_response');
    expect(f.check({ sid: SID, sub: USER, iat: iat() })).toBe('governance_stale');
    // A future issued_at (a skewed or forged answer) doesn't count either.
    answer = () => ({
      status: 200,
      body: state({ issued_at: new Date(c.now() + 31_000).toISOString() }),
    });
    expect(await f.pollOnce()).toBe('stale_response');

    // Keep a PEP fresh by replaying one good answer? It stops counting after 30 s.
    answer = () => ({ status: 200, body: state() });
    expect(await f.pollOnce()).toBe('confirmed');
    const captured = state();
    answer = () => ({ status: 200, body: captured });
    c.advance(31_000);
    expect(await f.pollOnce()).toBe('stale_response');
    c.advance(30_000);
    expect(f.check({ sid: SID, sub: USER, iat: iat() })).toBe('governance_stale');
  });

  it('a lower epoch than already seen is no confirmation; an equal one is', async () => {
    const f = feed();
    expect(await f.pollOnce()).toBe('confirmed');
    answer = () => ({ status: 200, body: state({ epoch: 9 }) });
    expect(await f.pollOnce()).toBe('epoch_regressed');
    answer = () => ({ status: 200, body: state({ epoch: 10 }) });
    expect(await f.pollOnce()).toBe('confirmed');
    expect(f.status().epoch).toBe(10);
  });

  it('revoked sessions and users: sid → session_revoked; iat < revoked_before → user_revoked', async () => {
    const f = feed();
    const before = new Date(c.now() + 30_000).toISOString(); // DB clock + 30 s
    answer = () => ({
      status: 200,
      body: state({
        revoked_sessions: [{ sid: OTHER_SID, revoked_at: new Date(c.now()).toISOString() }],
        users_revoked_before: [{ user_id: USER, revoked_before: before }],
      }),
    });
    await f.pollOnce();
    expect(f.check({ sid: OTHER_SID, sub: 'someone', iat: iat() })).toBe('session_revoked');
    expect(f.check({ sid: SID, sub: USER, iat: iat() + 29 })).toBe('user_revoked');
    expect(f.check({ sid: SID, sub: USER, iat: iat() + 31 })).toBe('ok');
  });

  it('merges overlapping answers by sid and user_id, keeping the latest revoked_before, and polls with since=cursor', async () => {
    const f = feed();
    const first = state({
      users_revoked_before: [{ user_id: USER, revoked_before: new Date(c.now()).toISOString() }],
    });
    answer = () => ({ status: 200, body: first });
    await f.pollOnce();
    c.advance(5_000);
    const later = new Date(c.now() + 30_000).toISOString();
    answer = () => ({
      status: 200,
      body: state({
        epoch: 11,
        users_revoked_before: [
          { user_id: USER, revoked_before: new Date(c.now() - 5_000).toISOString() },
          { user_id: USER, revoked_before: later },
        ],
      }),
    });
    await f.pollOnce();
    expect(f.check({ sid: SID, sub: USER, iat: iat() + 20 })).toBe('user_revoked');
    // An older (overlap) row can't move revoked_before back.
    answer = () => ({
      status: 200,
      body: state({ epoch: 11, users_revoked_before: first.users_revoked_before }),
    });
    await f.pollOnce();
    expect(f.check({ sid: SID, sub: USER, iat: iat() + 20 })).toBe('user_revoked');
    const urls = feedFetch.calls(`GET ${FEED}`).map((r) => r.url);
    expect(urls[0]).toBe(FEED);
    expect(urls[1]).toBe(`${FEED}?since=${encodeURIComponent(first.cursor)}`);
  });

  it('keeps revocations from a non-confirming answer (adding is safe) but not its kill switches or cursor', async () => {
    const f = feed();
    answer = () => ({
      status: 200,
      body: state({ kill_switches: [{ scope: 'tenant', scope_id: null, active: true }] }),
    });
    await f.pollOnce();
    expect(f.killSwitches()).toEqual([{ scope: 'tenant', scopeId: null, active: true }]);
    const replayed = state({
      epoch: 3,
      revoked_sessions: [{ sid: OTHER_SID, revoked_at: new Date(c.now()).toISOString() }],
      kill_switches: [{ scope: 'tenant', scope_id: null, active: false }],
      cursor: '2020-01-01T00:00:00.000Z',
    });
    answer = () => ({ status: 200, body: replayed });
    expect(await f.pollOnce()).toBe('epoch_regressed');
    expect(f.killSwitches()).toEqual([{ scope: 'tenant', scopeId: null, active: true }]);
    expect(f.check({ sid: OTHER_SID, sub: USER, iat: iat() })).toBe('session_revoked');
    await f.pollOnce();
    expect(feedFetch.requests.at(-1)?.url).not.toContain('2020-01-01');
  });

  it('401/403, invalid bodies and service-token failures are not confirmations', async () => {
    const outcomes: PollOutcome[] = [];
    const f = feed((o) => outcomes.push(o));
    answer = () => ({ status: 401, body: {} });
    await f.pollOnce();
    answer = () => ({ status: 200, body: { ...state(), epoch: 'x' } });
    await f.pollOnce();
    answer = () => ({ status: 200, body: { ...state(), extra: true } });
    await f.pollOnce();
    const failing = createRevocationFeed({
      url: FEED,
      serviceTokens: { getToken: () => Promise.reject(new Error('OpenBao down')) },
      fetch: feedFetch,
      now: c.now,
      onPoll: (o) => outcomes.push(o),
    });
    await failing.pollOnce();
    expect(outcomes).toEqual([
      'unauthorized',
      'invalid_response',
      'invalid_response',
      'unavailable',
    ]);
    expect(f.status().confirmedAt).toBeUndefined();
  });

  it('drops entries once no token they could affect can still be valid (max TTL + 5 min)', async () => {
    const f = feed();
    answer = () => ({
      status: 200,
      body: state({
        revoked_sessions: [{ sid: OTHER_SID, revoked_at: new Date(c.now()).toISOString() }],
      }),
    });
    await f.pollOnce();
    c.advance(65 * 60_000 + 1);
    answer = () => ({ status: 200, body: state({ epoch: 12 }) });
    await f.pollOnce();
    expect(f.check({ sid: OTHER_SID, sub: USER, iat: iat() })).toBe('ok');
  });

  describe('polling loop', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('stop() then start() while a poll is in flight leaves exactly one loop (generation counter)', async () => {
      let release = (): void => undefined;
      let gated = false;
      const gatedFetch = fakeFetch({
        [`GET ${FEED}`]: async () => {
          if (gated) {
            gated = false;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return answer();
        },
      });
      const f = createRevocationFeed({ url: FEED, serviceTokens: tokens, fetch: gatedFetch });
      await f.start(); // poll 1
      gated = true;
      await vi.advanceTimersByTimeAsync(5_000); // poll 2 starts and hangs
      expect(gatedFetch.requests).toHaveLength(2);
      f.stop();
      await f.start(); // poll 3 (new generation)
      release(); // poll 2 finishes for the OLD generation: it must not schedule a loop
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(gatedFetch.requests).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gatedFetch.requests).toHaveLength(6); // one loop: one poll per 5 s
      f.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(gatedFetch.requests).toHaveLength(6);
    });

    it('polls every 5 s after start() until stop()', async () => {
      const f = feed();
      expect(await f.start()).toBe('confirmed');
      expect(feedFetch.requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(feedFetch.requests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(feedFetch.requests).toHaveLength(4);
      f.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(feedFetch.requests).toHaveLength(4);
      const g = feed();
      await g.start();
      await expect(g.start()).rejects.toThrow('already started');
      g.stop();
    });
  });
});
