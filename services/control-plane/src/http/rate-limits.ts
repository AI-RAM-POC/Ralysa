// Rate limits on the unauthenticated routes (F-002 design §3.1; SEC-F002-16): /oauth2/*,
// /v1/auth/* and /.well-known/* have a per-client-IP AND a global per-instance limit, in
// one-minute fixed windows. A throttled request (429) is not a sign-in attempt (AC-4). In-memory
// per instance; the IP map is bounded (oldest entries are dropped past maxIps).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpProblem, OAuthProblem } from './errors.js';

export const LIMITED_PREFIXES = ['/oauth2/', '/v1/auth/', '/.well-known/'] as const;

export interface RateLimitOptions {
  perIpPerMinute: number;
  globalPerMinute: number;
  now?: () => number;
  maxIps?: number;
}

export interface RateLimiter {
  /** 0 when allowed, else the seconds until the window resets. */
  take(ip: string): number;
}

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const maxIps = options.maxIps ?? 50_000;
  let windowStart = now();
  let global = 0;
  let perIp = new Map<string, number>();
  return {
    take(ip) {
      const t = now();
      if (t - windowStart >= 60_000) {
        windowStart = t;
        global = 0;
        perIp = new Map();
      }
      const retry = Math.max(1, Math.ceil((windowStart + 60_000 - t) / 1000));
      if (global >= options.globalPerMinute) return retry;
      const used = perIp.get(ip) ?? 0;
      if (used >= options.perIpPerMinute) return retry;
      if (!perIp.has(ip) && perIp.size >= maxIps) {
        const oldest = perIp.keys().next().value;
        if (oldest !== undefined) perIp.delete(oldest);
      }
      perIp.set(ip, used + 1);
      global++;
      return 0;
    },
  };
}

const limited = (request: FastifyRequest): boolean => {
  const path = request.url.split('?')[0] ?? '';
  return LIMITED_PREFIXES.some((prefix) => path.startsWith(prefix));
};

export function registerRateLimits(app: FastifyInstance, limiter: RateLimiter): void {
  app.addHook('onRequest', (request, _reply, done) => {
    if (!limited(request)) {
      done();
      return;
    }
    const retry = limiter.take(request.ip);
    if (retry === 0) {
      done();
      return;
    }
    const headers = { 'retry-after': String(retry) };
    done(
      request.url.startsWith('/oauth2/')
        ? new OAuthProblem(
            { error: 'temporarily_unavailable', error_description: 'rate limited' },
            429,
            headers,
          )
        : new HttpProblem('rate_limited', undefined, { headers }),
    );
  });
}
