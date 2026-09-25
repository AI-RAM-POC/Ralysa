// Minting through KeyCustody (§3.2.2; SEC-F002-19): the token verifies with jose against the JWKS,
// the header is exactly {alg, typ, kid}, bad claims are never signed, and custody stops minting.
import { uuidv7 } from '@ralysa/protocol/common';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { mintAccessToken } from '../src/auth/tokens/mint.js';
import { fakeKeys } from './fixtures/fake-keys.js';

const now = Math.floor(Date.now() / 1000);
const claims = {
  iss: 'https://ralysa.example.qa',
  aud: 'model-gateway' as const,
  sub: uuidv7(),
  client_id: 'ralysa-cli',
  tid: uuidv7(),
  sid: uuidv7(),
  idp_sub: '4f1c2e3d-0000-4000-8000-000000000001',
  surface: 'cli' as const,
  auth_time: now,
  region: 'qa-doha',
  token_use: 'access' as const,
  iat: now,
  nbf: now,
  exp: now + 900,
  jti: uuidv7(),
};

describe('mintAccessToken', () => {
  it('produces an ES256 at+jwt that verifies with jose against the JWKS', async () => {
    const { keys } = await fakeKeys();
    const token = await mintAccessToken(keys, claims);
    expect(decodeProtectedHeader(token)).toEqual({
      alg: 'ES256',
      typ: 'at+jwt',
      kid: 'ralysa-rts-signing.v1',
    });
    const { payload, protectedHeader } = await jwtVerify(
      token,
      createLocalJWKSet(await keys.jwks()),
      {
        issuer: claims.iss,
        audience: 'model-gateway',
        typ: 'at+jwt',
        algorithms: ['ES256'],
      },
    );
    expect(protectedHeader.kid).toBe('ralysa-rts-signing.v1');
    expect(payload).toMatchObject({ sub: claims.sub, sid: claims.sid, token_use: 'access' });
  });

  it('mints a service token too', async () => {
    const { keys } = await fakeKeys();
    const token = await mintAccessToken(keys, {
      iss: claims.iss,
      aud: 'control-plane',
      sub: 'svc:model-gateway',
      client_id: 'svc:model-gateway',
      tid: claims.tid,
      token_use: 'service',
      iat: now,
      nbf: now,
      exp: now + 300,
      jti: uuidv7(),
    });
    await expect(
      jwtVerify(token, createLocalJWKSet(await keys.jwks()), { audience: 'control-plane' }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['an array audience', { aud: ['model-gateway', 'agent-host'] }],
    ['an unknown audience', { aud: 'evil' }],
    ['a non-UUID subject', { sub: 'alice' }],
  ])('refuses to mint with %s', async (_name, change) => {
    const { keys } = await fakeKeys();
    await expect(mintAccessToken(keys, { ...claims, ...change } as typeof claims)).rejects.toThrow(
      /refusing to mint/,
    );
  });

  it('refuses while the signing key is in custody violation', async () => {
    const { keys, state } = await fakeKeys();
    state.violation = 'exportable';
    await expect(mintAccessToken(keys, claims)).rejects.toThrow(/signing unavailable/);
  });
});
