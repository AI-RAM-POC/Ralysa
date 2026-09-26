// createServiceTokenVerifier (F-002 design §3.2.7; T11-11 in F-002-T12): the same header,
// signature and claim rules as the user-token verifier, for `token_use: service` tokens with
// `aud: control-plane`, plus the registered-client check. The control plane is the only PEP that
// accepts service tokens.
import { type TokenRejectReason } from '@ralysa/protocol/auth';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type RejectInfo,
  VerifierUnavailableError,
  createServiceTokenVerifier,
} from '../src/index.js';
import { ISSUER, KID_PREFIX, ORG, type TestKeys, fakeFetch, testKeys } from './support.js';

const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const SERVICE_CLAIMS = {
  aud: 'control-plane',
  sub: 'svc:model-gateway',
  client_id: 'svc:model-gateway',
  token_use: 'service',
};
const USER_ONLY = ['sid', 'idp_sub', 'surface', 'auth_time', 'region'];

describe('createServiceTokenVerifier', () => {
  let keys: TestKeys;
  const rejections: RejectInfo[] = [];

  const verifier = (overrides: Partial<Parameters<typeof createServiceTokenVerifier>[0]> = {}) =>
    createServiceTokenVerifier({
      issuer: ISSUER,
      jwksUrl: JWKS_URL,
      kidPrefix: KID_PREFIX,
      orgId: ORG,
      isRegistered: (clientId) => clientId === 'svc:model-gateway',
      onReject: (r) => rejections.push(r),
      fetch: fakeFetch({ [`GET ${JWKS_URL}`]: () => ({ status: 200, body: keys.jwks }) }),
      ...overrides,
    });
  const mintService = (claims: Record<string, unknown> = {}, header?: Record<string, unknown>) =>
    keys.mint({
      claims: { ...SERVICE_CLAIMS, ...claims },
      omit: USER_ONLY,
      ...(header === undefined ? {} : { header }),
    });

  beforeEach(async () => {
    keys = await testKeys();
    rejections.length = 0;
  });

  it('accepts a registered service token and yields the service', async () => {
    const result = await verifier().verify(`Bearer ${await mintService()}`);
    expect(result).toEqual({
      ok: true,
      service: expect.objectContaining({
        clientId: 'svc:model-gateway',
        service: 'model-gateway',
        orgId: ORG,
        expiresAt: expect.any(Date),
        tokenId: expect.any(String),
      }),
    });
    expect(rejections).toEqual([]);
  });

  const cases: [string, () => Promise<string>, TokenRejectReason][] = [
    [
      'a user access token',
      () => keys.mint({ claims: { aud: 'control-plane' } }),
      'wrong_token_use',
    ],
    [
      'an unregistered service',
      () => mintService({ sub: 'svc:other', client_id: 'svc:other' }),
      'wrong_token_use',
    ],
    [
      'client_id different from sub',
      () => mintService({ client_id: 'svc:agent-host' }),
      'malformed',
    ],
    ['another audience', () => mintService({ aud: 'model-gateway' }), 'wrong_audience'],
    [
      'another org',
      () => mintService({ tid: '0192f0a0-7b3c-7d4e-8f00-0000000000ff' }),
      'wrong_audience',
    ],
    ['typ JWT', () => mintService({}, { typ: 'JWT' }), 'wrong_typ'],
    ['jku', () => mintService({}, { jku: 'https://evil.example/jwks' }), 'forbidden_header'],
    ['a foreign kid', () => mintService({}, { kid: 'ralysa-other.v1' }), 'unknown_kid'],
    [
      'a sub that is not svc:<name>',
      () => mintService({ sub: 'model-gateway', client_id: 'model-gateway' }),
      'malformed',
    ],
    [
      'expired',
      () => {
        const t = Math.floor(Date.now() / 1000);
        return mintService({ iat: t - 600, nbf: t - 600, exp: t - 31 });
      },
      'expired',
    ],
  ];

  it.each(cases)('rejects %s', async (_name, token, reason) => {
    expect(await verifier().verify(await token(), { clientIp: '10.0.0.9' })).toEqual({
      ok: false,
      reason,
    });
    expect(rejections).toEqual([{ reason, clientIp: '10.0.0.9' }]);
  });

  it('without isRegistered, any authentic service token passes', async () => {
    const token = await mintService({ sub: 'svc:other', client_id: 'svc:other' });
    const v = createServiceTokenVerifier({
      issuer: ISSUER,
      jwksUrl: JWKS_URL,
      kidPrefix: KID_PREFIX,
      fetch: fakeFetch({ [`GET ${JWKS_URL}`]: () => ({ status: 200, body: keys.jwks }) }),
    });
    expect((await v.verify(token)).ok).toBe(true);
  });

  it('a local key set that throws is VerifierUnavailableError, not a rejection', async () => {
    const v = verifier({
      keySet: () => Promise.reject(new Error('database down')),
    });
    await expect(v.verify(await mintService())).rejects.toBeInstanceOf(VerifierUnavailableError);
    expect(rejections).toEqual([]);
  });

  it('VerifierUnavailableError carries the key set fault as its cause (R32 follow-up)', async () => {
    const fault = new Error('database down');
    const v = verifier({ keySet: () => Promise.reject(fault) });
    const error = await v.verify(await mintService()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VerifierUnavailableError);
    expect((error as Error).cause).toBe(fault);
    expect((error as Error).message).not.toContain('database down');
  });
});
