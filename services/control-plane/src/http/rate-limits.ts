// Rate limits on the unauthenticated routes (F-002 design §3.1; SEC-F002-16): /oauth2/*,
// /v1/auth/* and /.well-known/* have a per-client AND a global per-instance limit, in one-minute
// fixed windows. A throttled request (429) is not a sign-in attempt (AC-4). In-memory per
// instance; the client map is bounded (oldest entries are dropped past maxClients).
//
// Which requests are limited is decided on the MATCHED ROUTE TEMPLATE, not the raw URL: the router
// decodes percent-encoding, so /%2Ewell-known/jwks.json reaches the JWKS route and must be
// limited like it (code review of #25). A request that matches no route is judged on its decoded,
// lower-cased path, and one whose path can't be decoded is limited. The same decision picks the
// 429 body: an OAuth error on /oauth2/*, problem+json elsewhere.
//
// Clients are keyed by IP address, except IPv6, which is keyed by /64: one host usually holds a
// whole /64, so per-address keys would let it spread across 2^64 addresses (review of #25).
import { isIPv6 } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { networkOf } from '../audit/rejections.js';
import { HttpProblem, OAuthProblem } from './errors.js';

export const LIMITED_PREFIXES = ['/oauth2/', '/v1/auth/', '/.well-known/'] as const;

export interface RateLimitOptions {
  perIpPerMinute: number;
  globalPerMinute: number;
  now?: () => number;
  maxClients?: number;
}

export interface RateLimiter {
  /** 0 when allowed, else the seconds until the window resets. */
  take(clientKey: string): number;
}

/** IPv4 (and IPv4-mapped) addresses as they are; IPv6 by /64. */
export function clientKey(ip: string): string {
  if (ip.toLowerCase().startsWith('::ffff:')) return ip.slice(7);
  return isIPv6(ip) ? networkOf(ip) : ip;
}

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const maxClients = options.maxClients ?? 50_000;
  let windowStart = now();
  let global = 0;
  let perClient = new Map<string, number>();
  return {
    take(key) {
      const t = now();
      if (t - windowStart >= 60_000) {
        windowStart = t;
        global = 0;
        perClient = new Map();
      }
      const retry = Math.max(1, Math.ceil((windowStart + 60_000 - t) / 1000));
      if (global >= options.globalPerMinute) return retry;
      const used = perClient.get(key) ?? 0;
      if (used >= options.perIpPerMinute) return retry;
      if (!perClient.has(key) && perClient.size >= maxClients) {
        const oldest = perClient.keys().next().value;
        if (oldest !== undefined) perClient.delete(oldest);
      }
      perClient.set(key, used + 1);
      global++;
      return 0;
    },
  };
}

/** The limited family of a request, or undefined when it isn't rate-limited. */
export function limitedFamily(request: FastifyRequest): 'oauth' | 'problem' | undefined {
  let path = request.routeOptions.url;
  if (path === undefined) {
    try {
      path = decodeURIComponent(request.url.split('?')[0] ?? '').toLowerCase();
    } catch {
      return 'problem';
    }
  }
  if (path.startsWith('/oauth2/')) return 'oauth';
  return LIMITED_PREFIXES.some((prefix) => path.startsWith(prefix)) ? 'problem' : undefined;
}

export function registerRateLimits(app: FastifyInstance, limiter: RateLimiter): void {
  app.addHook('onRequest', (request, _reply, done) => {
    const family = limitedFamily(request);
    if (family === undefined) {
      done();
      return;
    }
    const retry = limiter.take(clientKey(request.ip));
    if (retry === 0) {
      done();
      return;
    }
    const headers = { 'retry-after': String(retry) };
    done(
      family === 'oauth'
        ? new OAuthProblem(
            { error: 'temporarily_unavailable', error_description: 'rate limited' },
            429,
            headers,
          )
        : new HttpProblem('rate_limited', undefined, { headers }),
    );
  });
}
