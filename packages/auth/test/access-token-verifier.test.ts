// TC-F-002-11 (unit): the verifier's rejection matrix with in-memory keys, every §3.2.2 reason
// code including `forbidden_header` [SEC-F002-19] and `issued_in_future` [SEC-F002-18 e]; the JWKS
// cache refetch on an unknown kid (cooldown 5 s) and its 60 s max age.
// TC-F-002-12 (unit): 1,000 verifications with a warm JWKS and feed, p95 ≤ 10 ms.
import { type Audience, type TokenRejectReason } from '@ralysa/protocol/auth';
import { SignJWT, base64url as joseB64 } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type RejectInfo,
  type RevocationSource,
  type RevocationVerdict,
  VerifierUnavailableError,
  createAccessTokenVerifier,
} from '../src/index.js';
import { monotonicMs, utf8 } from '../src/platform.js';
import {
  ISSUER,
  KID_PREFIX,
  ORG,
  SID,
  USER,
  type TestKeys,
  fakeFetch,
  testKeys,
} from './support.js';

const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

describe('createAccessTokenVerifier (TC-F-002-11)', () => {
  let keys: TestKeys;
  let verdict: RevocationVerdict;
  const revocation: RevocationSource = { check: () => verdict };
  const rejections: RejectInfo[] = [];
  let jwksFetch: ReturnType<typeof fakeFetch>;

  const verifier = (overrides: Partial<Parameters<typeof createAccessTokenVerifier>[0]> = {}) =>
    createAccessTokenVerifier({
      issuer: ISSUER,
      audience: 'model-gateway',
      jwksUrl: JWKS_URL,
      kidPrefix: KID_PREFIX,
      revocation,
      orgId: ORG,
      onReject: (r) => rejections.push(r),
      fetch: jwksFetch,
      ...overrides,
    });

  beforeEach(async () => {
    keys = await testKeys();
    verdict = 'ok';
    rejections.length = 0;
    jwksFetch = fakeFetch({ [`GET ${JWKS_URL}`]: () => ({ status: 200, body: keys.jwks }) });
  });

  it('accepts the Bearer scheme in any case (RFC 7235) and a bare token', async () => {
    const token = await keys.mint();
    for (const value of [`bearer ${token}`, `BEARER ${token}`, `BeArEr ${token}`, token]) {
      expect((await verifier().verify(value)).ok).toBe(true);
    }
    expect(await verifier().verify(`Basic ${token}`)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts a valid token and yields the principal', async () => {
    const result = await verifier().verify(`Bearer ${await keys.mint()}`, { clientIp: '10.0.0.7' });
    expect(result).toEqual({
      ok: true,
      principal: expect.objectContaining({
        userId: USER,
        orgId: ORG,
        sessionId: SID,
        audience: 'model-gateway',
        surface: 'cli',
        expiresAt: expect.any(Date),
      }),
    });
    expect(rejections).toEqual([]);
  });

  const nowS = () => Math.floor(Date.now() / 1000);
  const b64 = (value: unknown) => joseB64.encode(utf8(JSON.stringify(value)));
  const unsigned = (header: Record<string, unknown>, claims: Record<string, unknown>) =>
    `${b64(header)}.${b64(claims)}.${joseB64.encode(new Uint8Array(64))}`;

  const cases: [string, () => Promise<string>, TokenRejectReason][] = [
    ['garbage', () => Promise.resolve('not-a-token'), 'malformed'],
    ['a refresh token as bearer', () => Promise.resolve(`rly_rt_${'A'.repeat(43)}`), 'malformed'],
    [
      'alg none',
      () => Promise.resolve(unsigned({ alg: 'none', typ: 'at+jwt', kid: `${KID_PREFIX}.v1` }, {})),
      'wrong_alg',
    ],
    [
      'HS256 keyed with the public JWK',
      async () =>
        new SignJWT({ sub: USER })
          .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: `${KID_PREFIX}.v1` })
          .sign(utf8(JSON.stringify(keys.publicJwk()))),
      'wrong_alg',
    ],
    [
      'an Entra-style RS256 token',
      () =>
        Promise.resolve(unsigned({ alg: 'RS256', typ: 'JWT', kid: 'entra-kid' }, { ver: '2.0' })),
      'wrong_alg',
    ],
    ['typ JWT', () => keys.mint({ header: { typ: 'JWT' } }), 'wrong_typ'],
    ['jku', () => keys.mint({ header: { jku: 'https://evil.example/jwks' } }), 'forbidden_header'],
    ['jwk', () => keys.mint({ header: { jwk: keys.publicJwk() } }), 'forbidden_header'],
    ['x5u', () => keys.mint({ header: { x5u: 'https://evil.example/cert' } }), 'forbidden_header'],
    ['x5c', () => keys.mint({ header: { x5c: ['MIIB'] } }), 'forbidden_header'],
    ['crit', () => keys.mint({ header: { crit: ['b64'], b64: true } }), 'forbidden_header'],
    ['missing kid', () => keys.mint({ header: { kid: undefined } }), 'unknown_kid'],
    ['kid of another key', () => keys.mint({ header: { kid: 'ralysa-other.v1' } }), 'unknown_kid'],
    [
      'unknown kid version',
      () => keys.mint({ header: { kid: `${KID_PREFIX}.v9` } }),
      'unknown_kid',
    ],
    [
      'tampered signature',
      async () => {
        const [h = '', p = '', s = ''] = (await keys.mint()).split('.');
        return `${h}.${p}.${s.startsWith('A') ? `B${s.slice(1)}` : `A${s.slice(1)}`}`;
      },
      'bad_signature',
    ],
    [
      'tampered payload',
      async () => {
        const [h = '', , s = ''] = (await keys.mint()).split('.');
        return `${h}.${b64({ sub: USER, aud: 'model-gateway', role: 'admin' })}.${s}`;
      },
      'bad_signature',
    ],
    [
      'unknown issuer',
      () => keys.mint({ claims: { iss: 'https://evil.example' } }),
      'unknown_issuer',
    ],
    [
      'wrong audience control-plane',
      () => keys.mint({ claims: { aud: 'control-plane' } }),
      'wrong_audience',
    ],
    [
      'wrong audience agent-host',
      () => keys.mint({ claims: { aud: 'agent-host' } }),
      'wrong_audience',
    ],
    [
      'wrong audience mcp-gateway',
      () => keys.mint({ claims: { aud: 'mcp-gateway' } }),
      'wrong_audience',
    ],
    [
      'wrong audience workspace-runtime',
      () => keys.mint({ claims: { aud: 'workspace-runtime' } }),
      'wrong_audience',
    ],
    [
      'array audience',
      () => keys.mint({ claims: { aud: ['model-gateway', 'agent-host'] } }),
      'wrong_audience',
    ],
    [
      'another org',
      () => keys.mint({ claims: { tid: '0192f0a0-7b3c-7d4e-8f00-0000000000ff' } }),
      'wrong_audience',
    ],
    [
      'expired (past the 30 s skew)',
      () => keys.mint({ claims: { iat: nowS() - 1000, nbf: nowS() - 1000, exp: nowS() - 31 } }),
      'expired',
    ],
    ['nbf in the future', () => keys.mint({ claims: { nbf: nowS() + 120 } }), 'not_yet_valid'],
    ['iat in the future', () => keys.mint({ claims: { iat: nowS() + 120 } }), 'issued_in_future'],
    [
      'a service token',
      () =>
        keys.mint({
          claims: { sub: 'svc:model-gateway', token_use: 'service' },
          omit: ['sid', 'idp_sub', 'surface', 'auth_time', 'region'],
        }),
      'wrong_token_use',
    ],
    ['missing sid', () => keys.mint({ omit: ['sid'] }), 'malformed'],
    ['missing exp', () => keys.mint({ omit: ['exp'] }), 'malformed'],
    // Missing or mistyped claims are malformed, not a wrong value (review of #28).
    ['missing nbf', () => keys.mint({ omit: ['nbf'] }), 'malformed'],
    ['missing aud', () => keys.mint({ omit: ['aud'] }), 'malformed'],
    ['missing iss', () => keys.mint({ omit: ['iss'] }), 'malformed'],
    ['nbf not a number', () => keys.mint({ claims: { nbf: 'soon' } }), 'malformed'],
  ];

  it.each(cases)('rejects %s', async (_name, token, reason) => {
    const result = await verifier().verify(await token(), { clientIp: '10.0.0.7', traceId: 't1' });
    expect(result).toEqual({ ok: false, reason });
    expect(rejections).toEqual([{ reason, clientIp: '10.0.0.7', traceId: 't1' }]);
  });

  it('accepts exp and nbf inside the 30 s skew, and iat up to now + skew', async () => {
    const t = nowS();
    for (const claims of [
      { iat: t - 900, nbf: t - 900, exp: t - 20 },
      { nbf: t + 20 },
      { iat: t + 25 },
    ]) {
      expect((await verifier().verify(await keys.mint({ claims }))).ok).toBe(true);
    }
  });

  it.each([
    ['session_revoked', 'session_revoked'],
    ['user_revoked', 'user_revoked'],
    ['governance_stale', 'governance_stale'],
  ] as const)('passes the revocation verdict %s through', async (given, reason) => {
    verdict = given;
    expect(await verifier().verify(await keys.mint())).toEqual({ ok: false, reason });
  });

  it('asks the revocation source with sid, sub and iat, only after the token is authentic', async () => {
    const seen: unknown[] = [];
    const v = verifier({ revocation: { check: (t) => (seen.push(t), 'ok') } });
    await v.verify(await keys.mint({ header: { typ: 'JWT' } }));
    expect(seen).toEqual([]);
    const iat = nowS() - 5;
    await v.verify(await keys.mint({ claims: { iat } }));
    expect(seen).toEqual([{ sid: SID, sub: USER, iat }]);
  });

  it('a failing onReject never changes the answer', async () => {
    const v = verifier({
      onReject: () => {
        throw new Error('audit sink down');
      },
    });
    expect(await v.verify('nope')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('JWKS unreachable or not 200 → VerifierUnavailableError (fail closed, not a token rejection)', async () => {
    const down = fakeFetch({ [`GET ${JWKS_URL}`]: () => ({ status: 503, body: {} }) });
    await expect(verifier({ fetch: down }).verify(await keys.mint())).rejects.toBeInstanceOf(
      VerifierUnavailableError,
    );
    const broken = Object.assign(() => Promise.reject(new Error('ECONNREFUSED')), {});
    await expect(verifier({ fetch: broken }).verify(await keys.mint())).rejects.toBeInstanceOf(
      VerifierUnavailableError,
    );
    expect(rejections).toEqual([]);
  });

  describe('JWKS cache', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('refetches on an unknown kid after the 5 s cooldown, and at most every 60 s otherwise', async () => {
      const v = verifier();
      expect((await v.verify(await keys.mint())).ok).toBe(true);
      expect((await v.verify(await keys.mint())).ok).toBe(true);
      expect(jwksFetch.calls(`GET ${JWKS_URL}`)).toHaveLength(1);

      // RTS publishes v2 (publish-then-activate); a token signed with it arrives at once.
      await keys.rotate();
      const v2 = await keys.mint({ version: 2 });
      expect(await v.verify(v2)).toEqual({ ok: false, reason: 'unknown_kid' });
      vi.setSystemTime(Date.now() + 5_001);
      expect((await v.verify(v2)).ok).toBe(true);
      expect(jwksFetch.calls(`GET ${JWKS_URL}`)).toHaveLength(2);

      // Old-kid tokens keep validating while v1 is published (AC-10).
      expect((await v.verify(await keys.mint({ version: 1 }))).ok).toBe(true);
      vi.setSystemTime(Date.now() + 59_000);
      await v.verify(await keys.mint({ version: 1 }));
      expect(jwksFetch.calls(`GET ${JWKS_URL}`)).toHaveLength(2);
      vi.setSystemTime(Date.now() + 2_000);
      await v.verify(await keys.mint({ version: 1 }));
      expect(jwksFetch.calls(`GET ${JWKS_URL}`)).toHaveLength(3);
    });
  });
});

describe('verification latency (TC-F-002-12)', () => {
  it('1,000 verifications with a warm JWKS and feed: p95 ≤ 10 ms (target ≤ 2 ms)', async () => {
    const keys = await testKeys();
    const verifier = createAccessTokenVerifier({
      issuer: ISSUER,
      audience: 'model-gateway' satisfies Audience,
      jwksUrl: JWKS_URL,
      kidPrefix: KID_PREFIX,
      revocation: { check: () => 'ok' },
      fetch: fakeFetch({ [`GET ${JWKS_URL}`]: () => ({ status: 200, body: keys.jwks }) }),
    });
    const tokens = await Promise.all(Array.from({ length: 50 }, () => keys.mint()));
    expect((await verifier.verify(tokens[0] ?? '')).ok).toBe(true); // warm the cache
    const samples: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const start = monotonicMs();
      const result = await verifier.verify(tokens[i % tokens.length] ?? '');
      samples.push(monotonicMs() - start);
      if (!result.ok) throw new Error(`verification failed: ${result.reason}`);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? Infinity;
    const p50 = samples[Math.floor(samples.length * 0.5)] ?? Infinity;
    // Reported in the test output for the implementation notes.
    (globalThis as unknown as { console: { info(m: string): void } }).console.info(
      `TC-F-002-12: p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms over 1000`,
    );
    expect(p95).toBeLessThanOrEqual(10);
  });
});
