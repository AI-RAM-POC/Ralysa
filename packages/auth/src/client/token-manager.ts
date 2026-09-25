// The token manager (F-002 design §3.2.3, §3.6, §5.3): the ONE refresher per device.
//
// Contract [SEC-F002-17]. Exactly one process per device refreshes a session: the CLI (F-005) or
// the Desktop main process, through one TokenManager. Every other local consumer, the Agent Host
// (F-003) included, asks that process for access tokens through the `TokenProvider` over IPC and
// never reads the refresh token. RTS rotates the refresh token on every use and treats a second
// presentation of a rotated token as reuse: it revokes the whole session. So a second refresher on
// the same device (or a second TokenManager over the same store) is a defect that signs the user
// out.
//
// Within this manager every refresh is serialised (single flight): concurrent callers for one
// audience share one request, and a refresh for another audience waits for the one in flight, so
// the manager never presents a refresh token it has already rotated.
//
// Failures:
//   - `invalid_grant` (revoked, reuse, expired, user disabled): SessionRevokedError; the stored
//     refresh token is cleared, and the user signs in again.
//   - `temporarily_unavailable`, 5xx, 429 or no answer: TemporarilyUnavailableError; the refresh
//     token is kept. RTS consumes nothing before it answers 200, so a retry after a refusal is
//     safe. After a LOST answer (the request may have rotated the token), the retry presents the
//     old token, RTS sees reuse and revokes the session: the retry then fails with
//     SessionRevokedError and the user signs in again. That is the documented outcome (control-
//     plane README, review of #26 R26-10); there is no grace window (D-27).
//
// The refresh token lives only in the TokenStore (the OS credential store in F-005; there is
// deliberately no file-backed store) and in memory. Access tokens live in memory only.
import { type Audience, CLI_CLIENT_ID } from '@ralysa/protocol/auth';
import type { AuthConfig } from '@ralysa/protocol/control-plane';
import type { ClientOptions } from './config.js';
import { SessionRevokedError } from './errors.js';
import { revokeSession } from './revoke.js';
import { type TokenSet, postTokenGrant } from './token-set.js';

/** Implemented by F-005 on the OS credential store. There is deliberately no file-backed store. */
export interface TokenStore {
  load(): Promise<string | null>;
  save(refreshToken: string): Promise<void>;
  clear(): Promise<void>;
}

export interface TokenManager {
  /** Takes over a fresh sign-in (exchange or code redemption): stores its refresh token. */
  signedIn(tokens: TokenSet): Promise<void>;
  /** A usable access token for `audience` (default `control-plane`), refreshing when needed. */
  getAccessToken(audience?: Audience): Promise<string>;
  /** True when a refresh token is stored. It may still be refused at the next refresh. */
  hasSession(): Promise<boolean>;
  /**
   * Revokes the session at RTS, then forgets it locally. If RTS can't be reached, the local state
   * is kept and the error is thrown, unless `localOnly` (then only the local copy is dropped).
   */
  signOut(options?: { localOnly?: boolean }): Promise<void>;
}

export interface TokenManagerOptions extends ClientOptions {
  cfg: AuthConfig;
  store: TokenStore;
  now?: () => number;
}

/** Refresh this long before expiry (capped at half the token's life for short test lifetimes). */
const REFRESH_MARGIN_MS = 60_000;

interface Cached {
  token: string;
  obtainedAt: number;
  expiresAt: number;
}

export function createTokenManager(options: TokenManagerOptions): TokenManager {
  const { cfg, store } = options;
  const now = options.now ?? (() => Date.now());
  const http: ClientOptions = { fetch: options.fetch, timeoutMs: options.timeoutMs };
  const cached = new Map<Audience, Cached>();
  const inflight = new Map<Audience, Promise<string>>();
  /** undefined: not loaded from the store yet; null: no session. */
  let refreshToken: string | null | undefined;
  /** Every refresh, sign-in and sign-out runs after the previous one (single flight). */
  let tail: Promise<unknown> = Promise.resolve();

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };

  const usable = (entry: Cached | undefined): entry is Cached =>
    entry !== undefined &&
    now() < entry.expiresAt - Math.min(REFRESH_MARGIN_MS, (entry.expiresAt - entry.obtainedAt) / 2);

  const currentRefreshToken = async (): Promise<string | null> => {
    refreshToken ??= await store.load();
    return refreshToken;
  };

  const forget = async () => {
    refreshToken = null;
    cached.clear();
    await store.clear();
  };

  const refresh = async (audience: Audience): Promise<string> => {
    const presented = await currentRefreshToken();
    if (presented === null) {
      throw new SessionRevokedError('not signed in', 'auth.denied.revoked');
    }
    const obtainedAt = now();
    let set: TokenSet;
    try {
      set = await postTokenGrant(
        cfg,
        {
          grant_type: 'refresh_token',
          client_id: CLI_CLIENT_ID,
          refresh_token: presented,
          audience,
        },
        audience,
        'refresh',
        { ...http, now },
      );
    } catch (error) {
      if (error instanceof SessionRevokedError) await forget();
      throw error;
    }
    // The presented token is now rotated: hold the new one in memory before anything can fail.
    refreshToken = set.refreshToken;
    cached.set(audience, { token: set.accessToken, obtainedAt, expiresAt: set.expiresAt });
    await store.save(set.refreshToken);
    return set.accessToken;
  };

  return {
    signedIn(tokens) {
      return serial(async () => {
        refreshToken = tokens.refreshToken;
        cached.clear();
        cached.set(tokens.audience, {
          token: tokens.accessToken,
          obtainedAt: now(),
          expiresAt: tokens.expiresAt,
        });
        await store.save(tokens.refreshToken);
      });
    },

    getAccessToken(audience = 'control-plane') {
      const hit = cached.get(audience);
      if (usable(hit)) return Promise.resolve(hit.token);
      const pending = inflight.get(audience);
      if (pending !== undefined) return pending;
      const shared = serial(async () => {
        const again = cached.get(audience);
        return usable(again) ? again.token : refresh(audience);
      }).finally(() => inflight.delete(audience));
      inflight.set(audience, shared);
      return shared;
    },

    async hasSession() {
      return (await serial(currentRefreshToken)) !== null;
    },

    signOut(opts = {}) {
      return serial(async () => {
        const presented = await currentRefreshToken();
        if (presented !== null && opts.localOnly !== true) {
          await revokeSession(cfg, presented, http);
        }
        await forget();
      });
    },
  };
}
