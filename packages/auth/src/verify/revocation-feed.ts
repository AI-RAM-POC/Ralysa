// The PEP side of revocation (F-002 design §3.2.6, §3.4.3; identity-and-policy §5.6 G-1).
//
// `RevocationFeed` polls `GET /v1/internal/governance` every 5 s with the service's own token and
// keeps: revoked sessions (`sid`), per-user `revoked_before`, and kill-switch state. A poll counts
// as a CONFIRMATION only if the answer is authenticated (a 200 to our service token), validates
// against the contract, its `issued_at` is within 30 s of this PEP's clock, and its `epoch` is not
// lower than the last one seen [SEC-F002-18 a]. A cached or replayed answer therefore can't keep a
// PEP "fresh". Revocations from an answer that isn't a confirmation are still added (adding a
// revocation is always safe), but its kill-switch state and cursor are not taken.
//
// G-1: with no confirmation for more than 60 s, `check()` answers `governance_stale` for every
// token, so the verifier rejects everything until the feed is back.
//
// The feed's `cursor` lags `issued_at` by 60 s (T08-1), so answers overlap: entries are
// de-duplicated by `sid` and `user_id`, keeping the latest `revoked_before`. An entry is dropped
// once no token it could affect can still be valid (maximum access TTL + 5 min after it).
import {
  GOVERNANCE_FEED,
  GovernanceState,
  type KillSwitchScope,
} from '@ralysa/protocol/control-plane';
import { type HttpOptions, request } from '../http.js';
import { startTimer } from '../platform.js';
import type { ServiceTokenSource } from '../service/service-token-source.js';

export type RevocationVerdict = 'ok' | 'session_revoked' | 'user_revoked' | 'governance_stale';

/** What the verifier asks after a token passed its signature and claim checks. */
export interface RevocationSource {
  check(token: {
    sid: string;
    sub: string;
    iat: number;
  }): RevocationVerdict | Promise<RevocationVerdict>;
}

export interface KillSwitchState {
  scope: KillSwitchScope;
  scopeId: string | null;
  active: boolean;
}

export type PollOutcome =
  | 'confirmed'
  | 'stale_response'
  | 'epoch_regressed'
  | 'invalid_response'
  | 'unauthorized'
  | 'unavailable';

export interface RevocationFeed extends RevocationSource {
  /** Polls once, then every `pollMs` until `stop()`. Resolves after the first poll. */
  start(): Promise<PollOutcome>;
  stop(): void;
  /** One poll (tests, and a manual refresh). Never throws. */
  pollOnce(): Promise<PollOutcome>;
  /** The last confirmed kill-switch state (F-012 enforces it; F-002 only carries it). */
  killSwitches(): readonly KillSwitchState[];
  status(): { confirmedAt: number | undefined; epoch: number | undefined; stale: boolean };
}

export interface RevocationFeedOptions extends HttpOptions {
  /** `<control plane>/v1/internal/governance` */
  url: string;
  serviceTokens: ServiceTokenSource;
  /** Default 5000. */
  pollMs?: number;
  /** G-1 bound; default 60000. */
  staleAfterMs?: number;
  /** An answer whose `issued_at` is further than this from our clock is no confirmation; 30000. */
  maxIssuedAtSkewMs?: number;
  now?: () => number;
  onPoll?: (outcome: PollOutcome) => void;
}

export function createRevocationFeed(opts: RevocationFeedOptions): RevocationFeed {
  if (!/^https?:\/\/[^\s?#]+$/.test(opts.url))
    throw new Error('feed url must be a plain http(s) URL');
  const now = opts.now ?? (() => Date.now());
  const pollMs = opts.pollMs ?? GOVERNANCE_FEED.pollMs;
  const staleAfterMs = opts.staleAfterMs ?? GOVERNANCE_FEED.staleAfterMs;
  const maxSkewMs = opts.maxIssuedAtSkewMs ?? GOVERNANCE_FEED.maxIssuedAtSkewMs;
  const retentionMs = GOVERNANCE_FEED.defaultWindowSeconds * 1000;

  const revokedSessions = new Map<string, number>();
  const usersRevokedBefore = new Map<string, number>();
  let switches: KillSwitchState[] = [];
  let confirmedAt: number | undefined;
  let epoch: number | undefined;
  let cursor: string | undefined;
  let stopTimer: (() => void) | undefined;
  let running = false;
  /** Bumped by every start() and stop(): a poll that finishes for an old generation stops there. */
  let generation = 0;
  const current = (g: number) => running && g === generation;

  const merge = (state: GovernanceState) => {
    for (const s of state.revoked_sessions) {
      const at = Date.parse(s.revoked_at);
      revokedSessions.set(s.sid, Math.max(at, revokedSessions.get(s.sid) ?? at));
    }
    for (const u of state.users_revoked_before) {
      const before = Date.parse(u.revoked_before);
      usersRevokedBefore.set(
        u.user_id,
        Math.max(before, usersRevokedBefore.get(u.user_id) ?? before),
      );
    }
  };

  const prune = () => {
    const horizon = now() - retentionMs;
    for (const [sid, at] of revokedSessions) if (at < horizon) revokedSessions.delete(sid);
    for (const [user, before] of usersRevokedBefore) {
      if (before < horizon) usersRevokedBefore.delete(user);
    }
  };

  const pollOnce = async (): Promise<PollOutcome> => {
    let outcome: PollOutcome;
    try {
      const token = await opts.serviceTokens.getToken();
      const url =
        cursor === undefined ? opts.url : `${opts.url}?since=${encodeURIComponent(cursor)}`;
      const reply = await request(opts, 'GET', url, { bearer: token, what: 'governance feed' });
      if (reply.status === 401 || reply.status === 403) {
        outcome = 'unauthorized';
      } else if (reply.status !== 200) {
        outcome = 'unavailable';
      } else {
        const parsed = GovernanceState.safeParse(reply.body);
        if (!parsed.success) {
          outcome = 'invalid_response';
        } else {
          const state = parsed.data;
          merge(state);
          const issuedAt = Date.parse(state.issued_at);
          if (Math.abs(now() - issuedAt) > maxSkewMs) {
            outcome = 'stale_response';
          } else if (epoch !== undefined && state.epoch < epoch) {
            outcome = 'epoch_regressed';
          } else {
            epoch = state.epoch;
            cursor = state.cursor;
            // Credit the answer with no more freshness than it proves: it confirms the state as of
            // issued_at (never later than our clock), so an answer issued 29 s ago can't keep the
            // PEP "fresh" for 60 s more. G-1 stays 60 s of data age, not ~90 s (review of #28).
            confirmedAt = Math.min(now(), issuedAt);
            switches = state.kill_switches.map((k) => ({
              scope: k.scope,
              scopeId: k.scope_id,
              active: k.active,
            }));
            outcome = 'confirmed';
          }
        }
      }
    } catch {
      outcome = 'unavailable';
    }
    prune();
    opts.onPoll?.(outcome);
    return outcome;
  };

  const stale = () => confirmedAt === undefined || now() - confirmedAt > staleAfterMs;

  const loop = (g: number) => {
    stopTimer = startTimer(() => {
      void pollOnce().finally(() => {
        if (current(g)) loop(g);
      });
    }, pollMs);
  };

  return {
    check({ sid, sub, iat }) {
      if (stale()) return 'governance_stale';
      // The user-wide revocation first: disabling a user also revokes their sessions, and the
      // broader reason is the one worth recording.
      const before = usersRevokedBefore.get(sub);
      if (before !== undefined && iat * 1000 < before) return 'user_revoked';
      if (revokedSessions.has(sid)) return 'session_revoked';
      return 'ok';
    },
    async start() {
      if (running) throw new Error('feed already started');
      running = true;
      const g = ++generation;
      const first = await pollOnce();
      if (current(g)) loop(g);
      return first;
    },
    stop() {
      running = false;
      generation++;
      stopTimer?.();
      stopTimer = undefined;
    },
    pollOnce,
    killSwitches: () => switches,
    status: () => ({ confirmedAt, epoch, stale: stale() }),
  };
}
