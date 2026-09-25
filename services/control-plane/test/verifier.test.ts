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
import { createControlPlaneVerifier, createOwnKeySet } from '../src/auth/verifier.js';
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
        flush: () => undefined,
        size: () => ({ keys: 0, overflow: 0 }),
      },
    });
    const instance = await buildApp({
      config: serveConfig(),
      keys: fake.keys,
      rts,
      pingDatabase: () => Promise.resolve(true),
    });
    return { instance, rejected, fake };
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
