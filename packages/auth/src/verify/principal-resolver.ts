// Groups and roles for a verified user (F-002 design §3.4.2, §5.5, §6.1; AC-7 "yields groups";
// rev 10, #47): groups are not in the token, so a PEP asks
// `GET /v1/internal/principals/{user_id}?sid={sid}` with its service token and caches the answer
// for 30 s per (user, session). The cache is bounded, and concurrent lookups for one key share one
// request. A missing user is PrincipalNotFoundError; a session the control plane refuses (unknown,
// another user's, revoked, expired) is PrincipalSessionRefusedError; any other failure throws, so
// the PEP fails closed.
//
// `roles` are directory roles and never enough for `platform_admin` (SEC-F002-42). Pass the
// verified token's `sessionId` and authorize privileged actions on `session_roles`.
import { Principal } from '@ralysa/protocol/control-plane';
import { type HttpOptions, joinUrl, request } from '../http.js';
import type { ServiceTokenSource } from '../service/service-token-source.js';

export class PrincipalNotFoundError extends Error {
  constructor() {
    super('principal not found');
    this.name = 'PrincipalNotFoundError';
  }
}

export class PrincipalSessionRefusedError extends Error {
  constructor() {
    super('principal session refused');
    this.name = 'PrincipalSessionRefusedError';
  }
}

export class PrincipalUnavailableError extends Error {
  constructor(detail: string) {
    super(`principal lookup failed: ${detail}`);
    this.name = 'PrincipalUnavailableError';
  }
}

/** A principal resolved for a session: `session_id` and `session_roles` are always present. */
export type SessionPrincipal = Principal & {
  session_id: string;
  session_roles: NonNullable<Principal['session_roles']>;
};

export interface PrincipalResolver {
  /**
   * With `sessionId` (the verified token's `sid`), the answer carries `session_roles`: the
   * roles to authorize on. Without it, only directory roles (never enough for `platform_admin`).
   */
  resolve(userId: string, sessionId: string): Promise<SessionPrincipal>;
  resolve(userId: string): Promise<Principal>;
}

export interface PrincipalResolverOptions extends HttpOptions {
  /** The control plane's base URL. */
  baseUrl: string;
  serviceTokens: ServiceTokenSource;
  /** Default 30000. */
  ttlMs?: number;
  /** Default 10000 entries. */
  maxEntries?: number;
  now?: () => number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPrincipalResolver(opts: PrincipalResolverOptions): PrincipalResolver {
  const ttlMs = opts.ttlMs ?? 30_000;
  const maxEntries = opts.maxEntries ?? 10_000;
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<string, { at: number; principal: Principal }>();
  const pending = new Map<string, Promise<Principal>>();

  const load = async (key: string, userId: string, sessionId?: string): Promise<Principal> => {
    const token = await opts.serviceTokens.getToken();
    const path = `/v1/internal/principals/${userId}${sessionId === undefined ? '' : `?sid=${sessionId}`}`;
    let reply;
    try {
      reply = await request(opts, 'GET', joinUrl(opts.baseUrl, path), {
        bearer: token,
        what: 'principal lookup',
      });
    } catch {
      throw new PrincipalUnavailableError('unreachable');
    }
    if (reply.status === 404) throw new PrincipalNotFoundError();
    if (reply.status === 403 && sessionId !== undefined) throw new PrincipalSessionRefusedError();
    if (reply.status !== 200) throw new PrincipalUnavailableError(`status ${String(reply.status)}`);
    const parsed = Principal.safeParse(reply.body);
    const usable =
      parsed.success &&
      parsed.data.user_id.toLowerCase() === userId &&
      (sessionId === undefined
        ? parsed.data.session_roles === undefined
        : parsed.data.session_id?.toLowerCase() === sessionId &&
          parsed.data.session_roles !== undefined);
    if (!usable) throw new PrincipalUnavailableError('unusable answer');
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: now(), principal: parsed.data });
    return parsed.data;
  };

  const resolve = (userId: string, sessionId?: string): Promise<Principal> => {
    if (!UUID.test(userId)) return Promise.reject(new PrincipalNotFoundError());
    if (sessionId !== undefined && !UUID.test(sessionId)) {
      return Promise.reject(new PrincipalSessionRefusedError());
    }
    const user = userId.toLowerCase();
    const sid = sessionId?.toLowerCase();
    // One entry per (user, session): a session's roles never answer for another session.
    const key = `${user}|${sid ?? ''}`;
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at <= ttlMs) return Promise.resolve(hit.principal);
    const inflight = pending.get(key);
    if (inflight !== undefined) return inflight;
    const run = load(key, user, sid).finally(() => pending.delete(key));
    pending.set(key, run);
    return run;
  };
  return { resolve } as PrincipalResolver;
}
