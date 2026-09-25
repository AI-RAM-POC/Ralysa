// Hermetic test support: an in-memory "RTS" key set that mints tokens like RTS does (ES256,
// `typ: at+jwt`, `kid` = `ralysa-rts-signing.v<n>`), and a fetch router for fake endpoints.
import { type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { Fetch, FetchInit, FetchResponse } from '../src/index.js';
import { randomUuid } from '../src/platform.js';

export const ISSUER = 'https://ralysa.example.qa';
export const ORG = '0192f0a0-7b3c-7d4e-8f00-00000000000f';
export const USER = '0192f0a0-7b3c-7d4e-8f00-0000000000a1';
export const SID = '0192f0a0-7b3c-7d4e-8f00-0000000000b1';
export const KID_PREFIX = 'ralysa-rts-signing';

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export interface TestKeys {
  jwks: { keys: JWK[] };
  /** Adds a version (v1, v2, …) and publishes it. */
  rotate(): Promise<number>;
  mint(options?: MintOptions): Promise<string>;
  publicJwk(version?: number): JWK;
}

export interface MintOptions {
  version?: number;
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  omit?: string[];
  nowS?: number;
}

export function baseClaims(nowS: number): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: 'model-gateway',
    sub: USER,
    client_id: 'ralysa-cli',
    tid: ORG,
    sid: SID,
    idp_sub: 'b1e2c3d4-0000-4000-8000-00000000e001',
    surface: 'cli',
    auth_time: nowS - 60,
    region: 'qa-doha',
    token_use: 'access',
    iat: nowS,
    nbf: nowS,
    exp: nowS + 900,
    jti: randomUuid(),
  };
}

export async function testKeys(): Promise<TestKeys> {
  const versions: { privateKey: PrivateKey; jwk: JWK }[] = [];
  const jwks: { keys: JWK[] } = { keys: [] };
  const keys: TestKeys = {
    jwks,
    async rotate() {
      const pair = await generateKeyPair('ES256', { extractable: true });
      const jwk = await exportJWK(pair.publicKey);
      versions.push({ privateKey: pair.privateKey, jwk });
      const version = versions.length;
      jwks.keys.push({
        ...jwk,
        kid: `${KID_PREFIX}.v${String(version)}`,
        alg: 'ES256',
        use: 'sig',
      });
      return version;
    },
    async mint(options = {}) {
      const version = options.version ?? versions.length;
      const entry = versions[version - 1];
      if (entry === undefined) throw new Error('no such version');
      const claims: Record<string, unknown> = {
        ...baseClaims(options.nowS ?? Math.floor(Date.now() / 1000)),
        ...options.claims,
      };
      for (const name of options.omit ?? []) Reflect.deleteProperty(claims, name);
      return new SignJWT(claims)
        .setProtectedHeader({
          alg: 'ES256',
          typ: 'at+jwt',
          kid: `${KID_PREFIX}.v${String(version)}`,
          ...options.header,
        })
        .sign(entry.privateKey);
    },
    publicJwk(version = versions.length) {
      const entry = versions[version - 1];
      if (entry === undefined) throw new Error('no such version');
      return entry.jwk;
    },
  };
  await keys.rotate();
  return keys;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  form: Record<string, string>;
}

export type Handler = (
  request: RecordedRequest,
) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

/** A fetch that routes `METHOD url-without-query` to handlers and records every request. */
export function fakeFetch(routes: Record<string, Handler>): Fetch & {
  requests: RecordedRequest[];
  calls(route: string): RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch = async (url: string, init: FetchInit): Promise<FetchResponse> => {
    const method = init.method;
    const recorded: RecordedRequest = {
      method,
      url,
      headers: init.headers,
      body: init.body,
      form:
        init.headers['content-type'] === 'application/x-www-form-urlencoded' && init.body
          ? parseForm(init.body)
          : {},
    };
    requests.push(recorded);
    const handler = routes[`${method} ${url.split('?')[0] ?? url}`];
    if (handler === undefined) return { status: 404, json: () => Promise.resolve({}) };
    const reply = await handler(recorded);
    return {
      status: reply.status,
      json: () =>
        reply.body === undefined
          ? Promise.reject(new Error('no body'))
          : Promise.resolve(reply.body),
    };
  };
  return Object.assign(fetch, {
    requests,
    calls: (route: string) =>
      requests.filter((r) => `${r.method} ${r.url.split('?')[0] ?? r.url}` === route),
  });
}

/** A controllable clock. */
export function clock(start = Date.now()) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
}

/** `application/x-www-form-urlencoded` → record (no URLSearchParams type under the isomorphic lib). */
export function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of body.split('&')) {
    if (pair === '') continue;
    const [name = '', value = ''] = pair.split('=');
    out[decodeURIComponent(name.replace(/\+/g, ' '))] = decodeURIComponent(
      value.replace(/\+/g, ' '),
    );
  }
  return out;
}
