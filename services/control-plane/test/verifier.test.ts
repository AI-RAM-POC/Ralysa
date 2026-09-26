// The control plane on @ralysa/auth's verifier (T11-11, in F-002-T12): its own JWKS rows as the key
// set (re-read at most once a second), service tokens only for registered services, the Bearer
// scheme required at the route (any case), and an unreadable key set answered 503, not recorded
// as a token rejection. Revocation read from the database is covered by the integration suites.
import { uuidv7 } from '@ralysa/protocol/common';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Rejection } from '../src/audit/rejections.js';
import { createClientRegistry } from '../src/auth/clients.js';
import { mintAccessToken } from '../src/auth/tokens/mint.js';
import { VERIFIER_UNAVAILABLE_LOG_EVERY_MS } from '../src/auth/route-auth.js';
import { createControlPlaneVerifier, createOwnKeySet } from '../src/auth/verifier.js';
import { createPinoLogger } from '../src/observability/pino.js';
import { fakeKeys } from './fixtures/fake-keys.js';
import { fakeRts } from './fixtures/fake-rts.js';
import { ORG_ID, serveConfig } from './fixtures/serve-config.js';

const ISSUER = 'https://ralysa.example.qa';
const nowS = () => Math.floor(Date.now() / 1000);

const serviceClaims = (sub = 'svc:model-gateway') => ({
  iss: ISSUER,
  aud: 'control-plane' as const,
  sub,
  client_id: sub,
  tid: ORG_ID,
  token_use: 'service' as const,
  iat: nowS(),
  nbf: nowS(),
  exp: nowS() + 300,
  jti: uuidv7(),
});

const userClaims = () => ({
  iss: ISSUER,
  aud: 'control-plane' as const,
  sub: uuidv7(),
  client_id: 'ralysa-cli',
  tid: ORG_ID,
  sid: uuidv7(),
  idp_sub: '4f1c2e3d-0000-4000-8000-000000000001',
  surface: 'cli' as const,
  auth_time: nowS(),
  region: 'qa-doha',
  token_use: 'access' as const,
  iat: nowS(),
  nbf: nowS(),
  exp: nowS() + 900,
  jti: uuidv7(),
});

describe('createControlPlaneVerifier', () => {
  it('service tokens: registered services only; a user token is wrong_token_use', async () => {
    const { keys } = await fakeKeys();
    const config = serveConfig();
    const verifier = createControlPlaneVerifier({
      config,
      keys,
      db: fakeRts().db,
      clients: createClientRegistry(config),
    });
    const ok = await verifier.service.verify(
      `Bearer ${await mintAccessToken(keys, serviceClaims())}`,
    );
    expect(ok).toMatchObject({ ok: true, service: { service: 'model-gateway', orgId: ORG_ID } });
    const other = await mintAccessToken(keys, serviceClaims('svc:agent-host'));
    expect(await verifier.service.verify(`Bearer ${other}`)).toEqual({
      ok: false,
      reason: 'wrong_token_use',
    });
    const user = await mintAccessToken(keys, userClaims());
    expect(await verifier.service.verify(`Bearer ${user}`)).toEqual({
      ok: false,
      reason: 'wrong_token_use',
    });
    const service = await mintAccessToken(keys, serviceClaims());
    expect(await verifier.user.verify(`Bearer ${service}`)).toEqual({
      ok: false,
      reason: 'wrong_token_use',
    });
  });

  it('the own key set re-reads the JWKS rows at most once per second', async () => {
    const { keys } = await fakeKeys();
    const jwks = vi.spyOn(keys, 'jwks');
    let t = 0;
    const set = createOwnKeySet(keys, () => t);
    const token = await mintAccessToken(keys, serviceClaims());
    const [h = ''] = token.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg: string };
    const flattened = { payload: '', signature: '', protected: h };
    await set(header, flattened);
    await set(header, flattened);
    expect(jwks).toHaveBeenCalledTimes(1);
    t = 1_001;
    await set(header, flattened);
    expect(jwks).toHaveBeenCalledTimes(2);
  });
});

describe('route authentication', () => {
  async function app(keysOverride?: (k: Awaited<ReturnType<typeof fakeKeys>>) => void) {
    const fake = await fakeKeys();
    keysOverride?.(fake);
    const rejected: Rejection[] = [];
    const rts = fakeRts({
      rejections: {
        record: (r) => (rejected.push(r), 'written'),
        recordSuppressed: () => undefined,
        flush: () => undefined,
        size: () => ({ keys: 0, overflow: 0 }),
      },
    });
    const lines: string[] = [];
    const instance = await buildApp({
      config: serveConfig(),
      keys: fake.keys,
      rts,
      logger: createPinoLogger('info', { write: (line: string) => lines.push(line) }),
      pingDatabase: () => Promise.resolve(true),
    });
    const unavailable = () =>
      lines
        .map(
          (line) =>
            JSON.parse(line) as {
              msg?: string;
              route?: string;
              suppressed?: number;
              error?: Record<string, unknown>;
            },
        )
        .filter((line) => line.msg === 'verifier_unavailable');
    return { instance, rejected, fake, lines, unavailable };
  }

  it('a bare token (no Bearer scheme) is malformed and recorded under the config org', async () => {
    const { instance, rejected, fake } = await app();
    const token = await mintAccessToken(fake.keys, serviceClaims());
    const res = await instance.inject({
      url: '/v1/internal/governance',
      headers: { authorization: token, 'x-org-id': uuidv7() },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect(rejected).toEqual([
      expect.objectContaining({ orgId: ORG_ID, reason: 'malformed', audience: 'control-plane' }),
    ]);
  });

  it('the scheme is case-insensitive (RFC 7235): a lower-case bearer passes authentication', async () => {
    const { instance, rejected, fake } = await app();
    const token = await mintAccessToken(fake.keys, serviceClaims());
    const res = await instance.inject({
      url: '/v1/internal/principals/not-a-uuid',
      headers: { authorization: `bearer ${token}` },
    });
    // Past authentication, the path parameter is validated.
    expect(res.statusCode).toBe(400);
    expect(rejected).toEqual([]);
  });

  it('a revocation read that fails answers 503 and records no rejection (review of #32)', async () => {
    // fakeRts's database is unreachable (127.0.0.1:1): the user token is authentic, so the
    // verifier reaches the database revocation source, which can't answer.
    const { instance, rejected, fake } = await app();
    const token = await mintAccessToken(fake.keys, userClaims());
    const res = await instance.inject({
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'temporarily_unavailable' });
    expect(rejected).toEqual([]);
  });

  it('a revocation read fault is logged once at warn with its cause, and no token (R32 follow-up)', async () => {
    const { instance, fake, lines, unavailable } = await app();
    const token = await mintAccessToken(fake.keys, userClaims());
    const res = await instance.inject({
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
    const logged = unavailable();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 'warn', token_kind: 'user' });
    // The cause (the database fault), not the generic wrapper.
    expect(logged[0]?.error?.type).not.toBe('VerifierUnavailableError');
    expect(lines.join('\n')).not.toContain(token);
    expect(lines.join('\n')).not.toContain(token.split('.')[1] ?? token);
  });

  it('a key set fault is logged with a scrubbed summary of its cause and no token (R32 follow-up)', async () => {
    const { instance, fake, lines, unavailable } = await app();
    const token = await mintAccessToken(fake.keys, serviceClaims());
    // A fault whose message carries the token itself: the summary must scrub it.
    fake.keys.jwks = () => Promise.reject(new Error(`jwks rows unreadable near ${token}`));
    const res = await instance.inject({
      url: '/v1/internal/governance',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
    const logged = unavailable();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      level: 'warn',
      token_kind: 'service',
      error: { type: 'Error', message: expect.stringContaining('jwks rows unreadable') as string },
    });
    expect(lines.join('\n')).not.toContain(token);
    expect(lines.join('\n')).not.toContain(token.split('.')[1] ?? token);
  });

  it('verifier_unavailable is written at most once per route per window, with the skipped count (R35 nit)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { instance, fake, unavailable } = await app();
      const token = await mintAccessToken(fake.keys, serviceClaims());
      fake.keys.jwks = () => Promise.reject(new Error('database down'));
      const hit = async (url: string) =>
        (await instance.inject({ url, headers: { authorization: `Bearer ${token}` } })).statusCode;
      for (let i = 0; i < 3; i++) expect(await hit('/v1/internal/governance')).toBe(503);
      // Another route has its own window.
      expect(await hit('/v1/internal/principals/0192f0a0-7b3c-7d4e-8f00-000000000001')).toBe(503);
      expect(unavailable().map((l) => [l.route, l.suppressed])).toEqual([
        ['/v1/internal/governance', undefined],
        ['/v1/internal/principals/:user_id', undefined],
      ]);
      vi.setSystemTime(Date.now() + VERIFIER_UNAVAILABLE_LOG_EVERY_MS);
      expect(await hit('/v1/internal/governance')).toBe(503);
      expect(unavailable().at(-1)).toMatchObject({
        route: '/v1/internal/governance',
        suppressed: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unreadable key set answers 503 and records no rejection', async () => {
    const { instance, rejected, fake } = await app();
    const token = await mintAccessToken(fake.keys, serviceClaims());
    fake.keys.jwks = () => Promise.reject(new Error('database down'));
    const res = await instance.inject({
      url: '/v1/internal/governance',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
    expect(rejected).toEqual([]);
  });
});
