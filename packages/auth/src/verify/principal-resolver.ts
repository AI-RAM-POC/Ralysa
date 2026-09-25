// Groups and roles for a verified user (F-002 design §3.4.2, §5.5; AC-7 "yields groups"): groups
// are not in the token, so a PEP asks `GET /v1/internal/principals/{user_id}` with its service
// token and caches the answer for 30 s. The cache is bounded, and concurrent lookups for one user
// share one request. A missing user is PrincipalNotFoundError; any other failure throws, so the
// PEP fails closed.
import { Principal } from '@ralysa/protocol/control-plane';
import { type HttpOptions, joinUrl, request } from '../http.js';
import type { ServiceTokenSource } from '../service/service-token-source.js';

export class PrincipalNotFoundError extends Error {
  constructor() {
    super('principal not found');
    this.name = 'PrincipalNotFoundError';
  }
}

export class PrincipalUnavailableError extends Error {
  constructor(detail: string) {
    super(`principal lookup failed: ${detail}`);
    this.name = 'PrincipalUnavailableError';
  }
}

export interface PrincipalResolver {
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

  const load = async (userId: string): Promise<Principal> => {
    const token = await opts.serviceTokens.getToken();
    let reply;
    try {
      reply = await request(
        opts,
        'GET',
        joinUrl(opts.baseUrl, `/v1/internal/principals/${userId.toLowerCase()}`),
        { bearer: token, what: 'principal lookup' },
      );
    } catch {
      throw new PrincipalUnavailableError('unreachable');
    }
    if (reply.status === 404) throw new PrincipalNotFoundError();
    if (reply.status !== 200) throw new PrincipalUnavailableError(`status ${String(reply.status)}`);
    const parsed = Principal.safeParse(reply.body);
    if (!parsed.success || parsed.data.user_id.toLowerCase() !== userId.toLowerCase()) {
      throw new PrincipalUnavailableError('unusable answer');
    }
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
    cache.set(userId.toLowerCase(), { at: now(), principal: parsed.data });
    return parsed.data;
  };

  return {
    resolve(userId) {
      if (!UUID.test(userId)) return Promise.reject(new PrincipalNotFoundError());
      const key = userId.toLowerCase();
      const hit = cache.get(key);
      if (hit !== undefined && now() - hit.at <= ttlMs) return Promise.resolve(hit.principal);
      const inflight = pending.get(key);
      if (inflight !== undefined) return inflight;
      const run = load(key).finally(() => pending.delete(key));
      pending.set(key, run);
      return run;
    },
  };
}
