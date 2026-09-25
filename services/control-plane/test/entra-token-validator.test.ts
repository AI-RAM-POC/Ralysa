// The Entra token validator (F-002 design §3.2.5 steps 1–3; SEC-F002-07, -08, -19; TC-F-002-03
// and -24, unit part): header, signature and claim pinning, freshness, the RTS issuer refused,
// `uti` required, and the group-claim classification.
import { createHash, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { type JWK, createLocalJWKSet, exportJWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type EntraTokenValidator,
  classifyGroups,
  createEntraTokenValidator,
} from '../src/auth/idp/entra-token-validator.js';
import { serveConfig } from './fixtures/serve-config.js';

const config = serveConfig({ env: 'test' });
const TENANT = config.idp.tenant_id;
const ISSUER = config.idp.issuer;
const NOW = 1_800_000_000;
const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });
let validator: EntraTokenValidator;

function sign(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey = key.privateKey,
): string {
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  return `${input}.${b64u(rsaSign('sha256', Buffer.from(input), privateKey))}`;
}

const header = (over: Record<string, unknown> = {}) => ({
  alg: 'RS256',
  typ: 'JWT',
  kid: 'k1',
  ...over,
});
const claims = (over: Record<string, unknown> = {}) => ({
  aud: config.idp.rts_client_id,
  iss: ISSUER,
  iat: NOW - 30,
  nbf: NOW - 30,
  exp: NOW + 3600,
  azp: config.idp.allowed_public_client_ids[0],
  scp: 'Ralysa.SignIn',
  oid: '6A0E5A4E-1111-4222-8333-444455556666',
  sub: 'pairwise-sub',
  tid: TENANT,
  uti: 'AbCdEfGhIjKlMnOpQrStUv',
  ver: '2.0',
  preferred_username: 'alice@contoso.example',
  amr: ['pwd', 'mfa'],
  ipaddr: '127.0.0.1',
  groups: ['4f1c2e3d-0000-4000-8000-0000000000d1'],
  ...over,
});

beforeAll(async () => {
  const jwk = { ...(await exportJWK(key.publicKey)), kid: 'k1', alg: 'RS256' } as JWK;
  validator = createEntraTokenValidator({
    config,
    keys: createLocalJWKSet({ keys: [jwk] }),
    now: () => NOW * 1000,
  });
});

const failsWith = async (token: string, reason: string, check?: string) => {
  const result = await validator.validateAccessToken(token);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe(reason);
    if (check !== undefined) expect(result.check).toBe(check);
  }
  return result;
};

describe('Entra token validator', () => {
  it('accepts an Entra v2 access token and maps oid (lower-cased), never sub', async () => {
    const result = await validator.validateAccessToken(sign(header(), claims()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity).toMatchObject({
        oid: '6a0e5a4e-1111-4222-8333-444455556666',
        tenantId: TENANT,
        uti: 'AbCdEfGhIjKlMnOpQrStUv',
        amr: ['pwd', 'mfa'],
        acrs: [],
        ipaddr: '127.0.0.1',
        groups: { kind: 'list', guids: ['4f1c2e3d-0000-4000-8000-0000000000d1'], ignored: 0 },
      });
      expect(JSON.stringify(result.identity)).not.toContain('pairwise-sub');
    }
  });

  it('accepts Entra x5t in the header', async () => {
    expect((await validator.validateAccessToken(sign(header({ x5t: 'abc' }), claims()))).ok).toBe(
      true,
    );
  });

  it('refuses a token issued by RTS itself as untrusted_issuer, before anything else', async () => {
    const rts = sign(
      { alg: 'ES256', typ: 'at+jwt', kid: 'ralysa-rts-signing.v1' },
      claims({ iss: config.public_base_url }),
    );
    await failsWith(rts, 'untrusted_issuer', 'rts_issuer');
  });

  it.each([
    ['alg none', header({ alg: 'none' }), 'alg'],
    ['alg HS256', header({ alg: 'HS256' }), 'alg'],
    ['alg ES256', header({ alg: 'ES256' }), 'alg'],
    ['typ at+jwt', header({ typ: 'at+jwt' }), 'typ'],
    ['no kid', { alg: 'RS256', typ: 'JWT' }, 'kid'],
    ['jku', header({ jku: 'https://evil.example/jwks' }), 'header_member'],
    ['jwk', header({ jwk: { kty: 'RSA' } }), 'header_member'],
    ['x5u', header({ x5u: 'https://evil.example/c' }), 'header_member'],
    ['x5c', header({ x5c: ['MII'] }), 'header_member'],
    ['crit', header({ crit: ['exp'] }), 'header_member'],
    ['nonce', header({ nonce: 'n' }), 'header_member'],
  ])('refuses a header with %s (SEC-F002-07, -19)', async (_name, h, check) => {
    await failsWith(sign(h, claims()), 'invalid_idp_token', check);
  });

  it('refuses a bad signature and garbage', async () => {
    await failsWith(sign(header(), claims(), foreign.privateKey), 'invalid_idp_token', 'signature');
    const good = sign(header(), claims());
    const [h, , s] = good.split('.');
    await failsWith(
      `${h ?? ''}.${b64u(JSON.stringify(claims({ oid: 'x' })))}.${s ?? ''}`,
      'invalid_idp_token',
      'signature',
    );
    await failsWith('not-a-jwt', 'invalid_idp_token', 'structure');
    await failsWith('a.b.c', 'invalid_idp_token', 'structure');
  });

  it.each([
    [
      'another tenant issuer',
      { iss: 'https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/v2.0' },
      'untrusted_issuer',
      'iss',
    ],
    [
      'a v1 issuer',
      { iss: `https://sts.windows.net/${TENANT}/`, ver: '1.0' },
      'untrusted_issuer',
      'iss',
    ],
    ['another tid', { tid: '11111111-2222-4333-8444-555555555555' }, 'untrusted_issuer', 'tid'],
    ['expired', { exp: NOW - 61 }, 'expired', 'exp'],
    ['iat older than 10 min', { iat: NOW - 601 }, 'expired', 'iat_age'],
    ['nbf in the future', { nbf: NOW + 61 }, 'invalid_idp_token', 'nbf'],
    ['iat in the future', { iat: NOW + 61 }, 'invalid_idp_token', 'iat_future'],
    ['ver 1.0', { ver: '1.0' }, 'invalid_idp_token', 'ver'],
    ['another audience', { aud: 'https://graph.microsoft.com' }, 'invalid_idp_token', 'aud'],
    [
      'azp not allowed',
      { azp: '11111111-2222-4333-8444-555555555555' },
      'invalid_idp_token',
      'azp',
    ],
    ['no scp', { scp: undefined }, 'invalid_idp_token', 'scp'],
    ['another scope', { scp: 'User.Read' }, 'invalid_idp_token', 'scp'],
    ['non-GUID oid', { oid: 'alice' }, 'invalid_idp_token', 'oid'],
    ['no uti (SEC-F002-07)', { uti: undefined }, 'invalid_idp_token', 'uti'],
  ])('refuses %s', async (_name, over, reason, check) => {
    await failsWith(sign(header(), claims(over)), reason, check);
  });

  it('keeps the unverified preferred_username only for the HMAC', async () => {
    const result = await failsWith(sign(header(), claims({ tid: 'x' })), 'untrusted_issuer');
    if (!result.ok) expect(result.unverifiedIdentifier).toBe('alice@contoso.example');
  });

  it('allows 60 s of clock skew on exp', async () => {
    expect(
      (await validator.validateAccessToken(sign(header(), claims({ exp: NOW - 59 })))).ok,
    ).toBe(true);
  });
});

describe('group claim classification (SEC-F002-08)', () => {
  it('keeps GUIDs, lower-cased and unique, and counts the rest', () => {
    expect(
      classifyGroups({
        groups: [
          '4F1C2E3D-0000-4000-8000-0000000000D1',
          'CONTOSO\\Ralysa Users',
          '4f1c2e3d-0000-4000-8000-0000000000d1',
        ],
      }),
    ).toEqual({ kind: 'list', guids: ['4f1c2e3d-0000-4000-8000-0000000000d1'], ignored: 1 });
  });

  it('notes overage and never follows _claim_sources', () => {
    expect(classifyGroups({ _claim_names: { groups: 'src1' } })).toEqual({ kind: 'overage' });
  });

  it('absent groups are absent (Graph decides)', () => {
    expect(classifyGroups({})).toEqual({ kind: 'absent' });
  });
});

it('the replay key is a SHA-256 of uti', async () => {
  const { replayKey } = await import('../src/auth/sign-in.js');
  expect(replayKey('abc')).toEqual(createHash('sha256').update('abc').digest());
});
