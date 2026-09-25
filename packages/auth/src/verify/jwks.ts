// The verifier's JWKS cache (F-002 design §3.2.4, §3.6): jose's remote key set over RTS's
// `/.well-known/jwks.json`, cached for at most 60 s and re-fetched on an unknown `kid` at most
// every 5 s. RTS publishes a new key 120 s before it signs with it, and 30 + 60 + 5 = 95 s < 120 s,
// so every verifier holds the key before the first token signed with it exists (AC-10).
import { createRemoteJWKSet, customFetch } from 'jose';
import { type Fetch, defaultFetch, newUrl } from '../platform.js';

export const JWKS_CACHE_MAX_AGE_MS = 60_000;
export const JWKS_COOLDOWN_MS = 5_000;

export type JwksKeySet = ReturnType<typeof createRemoteJWKSet>;

export function createJwksCache(opts: {
  url: string;
  fetch?: Fetch;
  timeoutMs?: number;
}): JwksKeySet {
  if (!/^https?:\/\/[^\s?#]+$/.test(opts.url))
    throw new Error('jwksUrl must be a plain http(s) URL');
  const fetch = opts.fetch ?? defaultFetch();
  return createRemoteJWKSet(newUrl(opts.url), {
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    timeoutDuration: opts.timeoutMs ?? 5_000,
    [customFetch]: (url: string, init: { signal?: unknown; headers?: unknown }) =>
      fetch(url, {
        method: 'GET',
        headers: headerRecord(init.headers),
        signal: init.signal,
        redirect: 'manual',
      }),
  });
}

function headerRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = { accept: 'application/json' };
  if (typeof headers === 'object' && headers !== null && Symbol.iterator in headers) {
    for (const [name, value] of headers as Iterable<[string, string]>) out[name] = value;
  }
  return out;
}
