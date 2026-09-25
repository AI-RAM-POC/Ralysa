// Service identity (§3.2.7, [AR-1]): the Transit-backed assertion signer over @ralysa/secrets'
// KeyCustody (the in-memory double here; the OpenBao adapter in the integration test), the RFC
// 7523 assertion RTS expects, and renewal at 50 % of the TTL with jitter while the current token
// stays in use until it expires.
import { createInMemoryKeyCustody } from '@ralysa/secrets';
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  ASSERTION_LIFETIME_S,
  ServiceTokenUnavailableError,
  createClientAssertion,
  createServiceTokenSource,
  createTransitAssertionSigner,
} from '../src/index.js';
import { clock, fakeFetch } from './support.js';

const TOKEN_ENDPOINT = 'https://ralysa.example.qa/oauth2/token';
const INTERNAL = 'http://control-plane.internal:4100/oauth2/token';

async function signer() {
  const custody = createInMemoryKeyCustody();
  await custody.rotate('ralysa-svc-model-gateway');
  return {
    custody,
    signer: createTransitAssertionSigner({ custody, transitKey: 'ralysa-svc-model-gateway' }),
  };
}

describe('client assertions', () => {
  it('are ES256 over the latest Transit version, with the claims and lifetime RTS requires', async () => {
    const { custody, signer: s } = await signer();
    await custody.rotate('ralysa-svc-model-gateway');
    const nowSeconds = 1_790_000_000;
    const jwt = await createClientAssertion({
      clientId: 'svc:model-gateway',
      audience: TOKEN_ENDPOINT,
      signer: s,
      nowSeconds,
    });
    expect(decodeProtectedHeader(jwt)).toEqual({
      alg: 'ES256',
      typ: 'JWT',
      kid: 'ralysa-svc-model-gateway.v2',
    });
    const described = await custody.describe('ralysa-svc-model-gateway');
    const key = await importJWK({ ...described.versions[1]?.jwk }, 'ES256');
    const { payload } = await jwtVerify(jwt, key, {
      issuer: 'svc:model-gateway',
      subject: 'svc:model-gateway',
      audience: TOKEN_ENDPOINT,
      currentDate: new Date(nowSeconds * 1000),
    });
    expect(payload.exp).toBe(nowSeconds + ASSERTION_LIFETIME_S);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(60);
    const other = await createClientAssertion({
      clientId: 'svc:model-gateway',
      audience: TOKEN_ENDPOINT,
      signer: s,
    });
    expect(decodeJwt(other).jti).not.toBe(payload.jti);
  });

  it('a key that violates custody signs nothing (SEC-F002-11)', async () => {
    const { custody, signer: s } = await signer();
    custody.setFlags('ralysa-svc-model-gateway', { exportable: true });
    await expect(
      createClientAssertion({ clientId: 'svc:model-gateway', audience: TOKEN_ENDPOINT, signer: s }),
    ).rejects.toThrow();
  });

  it('refuses a transit key or client id outside the naming rules', () => {
    const custody = createInMemoryKeyCustody();
    expect(() =>
      createTransitAssertionSigner({ custody, transitKey: 'ralysa-rts-signing' }),
    ).toThrow();
    expect(() =>
      createServiceTokenSource({
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: 'model-gateway',
        signer: { sign: () => Promise.reject(new Error('unused')) },
      }),
    ).toThrow();
  });
});

describe('createServiceTokenSource', () => {
  const setup = async (random = 0) => {
    const c = clock(1_790_000_000_000);
    const { signer: s } = await signer();
    let n = 0;
    let down = false;
    const fetch = fakeFetch({
      [`POST ${INTERNAL}`]: () => {
        if (down) return { status: 503, body: { error: 'temporarily_unavailable' } };
        n++;
        return {
          status: 200,
          body: { access_token: `svc-${String(n)}`, token_type: 'Bearer', expires_in: 300 },
        };
      },
    });
    const source = createServiceTokenSource({
      tokenEndpoint: INTERNAL,
      assertionAudience: TOKEN_ENDPOINT,
      clientId: 'svc:model-gateway',
      signer: s,
      fetch,
      now: c.now,
      random: () => random,
    });
    return {
      c,
      fetch,
      source,
      setDown: (v: boolean) => {
        down = v;
      },
    };
  };

  it('posts client_credentials with a jwt-bearer assertion whose aud is RTS’s own token endpoint URL', async () => {
    const { fetch, source } = await setup();
    expect(await source.getToken()).toBe('svc-1');
    const form = fetch.requests[0]?.form ?? {};
    expect(form).toMatchObject({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_id: 'svc:model-gateway',
    });
    expect(decodeJwt(form.client_assertion ?? '')).toMatchObject({
      iss: 'svc:model-gateway',
      sub: 'svc:model-gateway',
      aud: TOKEN_ENDPOINT,
    });
  });

  it('renews at 50 % of the TTL (+ jitter), serving the current token meanwhile', async () => {
    const { c, fetch, source } = await setup(0);
    const settle = () => source.settled();
    expect(await source.getToken()).toBe('svc-1');
    c.advance(149_000);
    expect(await source.getToken()).toBe('svc-1');
    expect(fetch.requests).toHaveLength(1);
    c.advance(1_000); // 50 %
    expect(await source.getToken()).toBe('svc-1'); // renewal runs in the background
    await settle();
    expect(fetch.requests).toHaveLength(2);
    expect(await source.getToken()).toBe('svc-2');
  });

  it('jitter spreads renewal over 50–60 % of the TTL', async () => {
    const { c, fetch, source } = await setup(0.999);
    const settle = () => source.settled();
    await source.getToken();
    c.advance(179_000);
    await source.getToken();
    await settle();
    expect(fetch.requests).toHaveLength(1);
    c.advance(1_000);
    await source.getToken();
    await settle();
    expect(fetch.requests).toHaveLength(2);
  });

  it('keeps the current token while renewal fails, retries with backoff, and fails closed after exp', async () => {
    const { c, fetch, source, setDown } = await setup(0);
    const settle = () => source.settled();
    await source.getToken();
    setDown(true);
    c.advance(150_000);
    expect(await source.getToken()).toBe('svc-1');
    await settle();
    expect(await source.getToken()).toBe('svc-1'); // inside the 1 s backoff: no new request
    await settle();
    expect(fetch.requests).toHaveLength(2);
    c.advance(145_001); // 5 s before exp: no longer handed out
    await expect(source.getToken()).rejects.toBeInstanceOf(ServiceTokenUnavailableError);
    expect(fetch.requests).toHaveLength(3);
    setDown(false);
    // Still inside the (now 2 s) backoff: refused without calling OpenBao or RTS.
    await expect(source.getToken()).rejects.toBeInstanceOf(ServiceTokenUnavailableError);
    expect(fetch.requests).toHaveLength(3);
    c.advance(2_000);
    expect(await source.getToken()).toBe('svc-2');
  });

  it('after exp, an outage does not turn every getToken() into a Transit + RTS call (AR-1)', async () => {
    const { c, fetch, source, setDown } = await setup(0);
    await source.getToken();
    setDown(true);
    c.advance(296_000); // expired, no renewal attempted yet
    await expect(source.getToken()).rejects.toBeInstanceOf(ServiceTokenUnavailableError);
    for (let i = 0; i < 50; i++) {
      await expect(source.getToken()).rejects.toBeInstanceOf(ServiceTokenUnavailableError);
    }
    expect(fetch.requests).toHaveLength(2);
    // Backoff doubles: 1 s, 2 s, 4 s … capped at 30 s.
    c.advance(1_000);
    await expect(source.getToken()).rejects.toBeInstanceOf(ServiceTokenUnavailableError);
    c.advance(1_000);
    await expect(source.getToken()).rejects.toBeInstanceOf(ServiceTokenUnavailableError);
    expect(fetch.requests).toHaveLength(3);
    c.advance(1_000);
    await source.getToken().catch(() => undefined);
    expect(fetch.requests).toHaveLength(4);
  });

  it('concurrent callers share one request', async () => {
    const { fetch, source } = await setup();
    const tokens = await Promise.all(Array.from({ length: 10 }, () => source.getToken()));
    expect(new Set(tokens)).toEqual(new Set(['svc-1']));
    expect(fetch.requests).toHaveLength(1);
  });
});
