// Client flows with fake IdP and RTS endpoints (the mock IdP, T09, is built in parallel; the
// token-exchange grant at RTS is T10, so flow A runs end to end against fakes here).
//   - TC-F-002-02 (client half): startIdpDeviceSignIn returns the IdP's user code, verification
//     URI and interval; polling handles authorization_pending and slow_down and yields the IdP
//     token; the exchange returns Ralysa tokens.
//   - AC-4: every IdP-side failure is reported to /v1/auth/sign-in-failures BEFORE the typed error
//     is thrown; a user cancel is not reported.
//   - config pinning, PKCE and the authorize URL, the loopback callback, code redemption, revoke,
//     typed errors with known i18n keys only.
import type { AuthConfig } from '@ralysa/protocol/control-plane';
import { AUTH_I18N_KEYS } from '@ralysa/protocol/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AbortSignalLike,
  AccessDeniedError,
  AuthProtocolError,
  DeviceCodeBlockedError,
  DeviceCodeExpiredError,
  SessionRevokedError,
  TemporarilyUnavailableError,
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeIdpToken,
  fetchAuthConfig,
  readAuthorizationCallback,
  redeemAuthorizationCode,
  revokeSession,
  startIdpDeviceSignIn,
} from '../src/index.js';
import { base64url, sha256, utf8 } from '../src/platform.js';
import { ISSUER, type Handler, fakeFetch } from './support.js';

const TENANT = '4f1c2e3d-0000-4000-8000-0000000000aa';
const DEVICE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`;
const IDP_TOKEN = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const RTS_TOKEN = `${ISSUER}/oauth2/token`;
const FAILURES = `${ISSUER}/v1/auth/sign-in-failures`;
const RT = `rly_rt_${'a'.repeat(43)}`;

const cfg: AuthConfig = {
  issuer: ISSUER,
  flows: { idp_device: true, loopback_pkce: true },
  idp: {
    kind: 'entra',
    device_authorization_endpoint: DEVICE,
    token_endpoint: IDP_TOKEN,
    cli_client_id: '4f1c2e3d-0000-4000-8000-0000000000cc',
    scope: 'api://ralysa-rts/Ralysa.SignIn',
  },
  cli_client_id: 'ralysa-cli',
};

const deviceStart = {
  status: 200,
  body: {
    device_code: 'DEVICE-CODE-1',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://microsoft.com/devicelogin',
    expires_in: 900,
    interval: 5,
    message: 'vendor text is ignored',
  },
};
const rtsTokens = {
  status: 200,
  body: {
    access_token: 'header.payload.signature',
    token_type: 'Bearer',
    expires_in: 900,
    refresh_token: RT,
    issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  },
};

/** Answers the IdP token endpoint from a script, one entry per poll. */
function scripted(steps: { status: number; body?: unknown }[]): Handler {
  let i = 0;
  return () => steps[Math.min(i++, steps.length - 1)] ?? { status: 500 };
}

describe('client flows', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('TC-F-002-02: config → IdP device flow (pending, slow_down) → exchange → Ralysa tokens', async () => {
    const fetch = fakeFetch({
      [`GET ${ISSUER}/v1/auth/config`]: () => ({ status: 200, body: cfg }),
      [`POST ${DEVICE}`]: () => deviceStart,
      [`POST ${IDP_TOKEN}`]: scripted([
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 400, body: { error: 'slow_down' } },
        { status: 400, body: { error: 'authorization_pending' } },
        {
          status: 200,
          body: { access_token: 'idp.access.token', token_type: 'Bearer', expires_in: 3600 },
        },
      ]),
      [`POST ${RTS_TOKEN}`]: () => rtsTokens,
    });
    const config = await fetchAuthConfig(`${ISSUER}/`, { fetch });
    const signIn = await startIdpDeviceSignIn(config, { fetch });
    expect(signIn).toMatchObject({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://microsoft.com/devicelogin',
      intervalSeconds: 5,
      expiresInSeconds: 900,
    });
    expect(fetch.calls(`POST ${DEVICE}`)[0]?.form).toEqual({
      client_id: cfg.idp.cli_client_id,
      scope: 'api://ralysa-rts/Ralysa.SignIn',
    });

    const polled = signIn.poll();
    await vi.advanceTimersByTimeAsync(5_000 + 5_000 + 10_000 + 10_000);
    expect(await polled).toEqual({ idpAccessToken: 'idp.access.token' });
    const polls = fetch.calls(`POST ${IDP_TOKEN}`);
    expect(polls).toHaveLength(4);
    expect(polls[0]?.form).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: cfg.idp.cli_client_id,
      device_code: 'DEVICE-CODE-1',
    });

    const tokens = await exchangeIdpToken(config, 'idp.access.token', {
      fetch,
      deviceLabel: 'laptop',
      audience: 'model-gateway',
    });
    expect(tokens).toMatchObject({
      accessToken: 'header.payload.signature',
      refreshToken: RT,
      audience: 'model-gateway',
    });
    expect(fetch.calls(`POST ${RTS_TOKEN}`)[0]?.form).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: 'ralysa-cli',
      subject_token: 'idp.access.token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      audience: 'model-gateway',
      device_label: 'laptop',
    });
    expect(fetch.calls(`POST ${FAILURES}`)).toEqual([]);
  });

  const failureCases: [
    string,
    { status: number; body?: unknown },
    string,
    new (...a: never[]) => Error,
    string?,
  ][] = [
    [
      'declined',
      { status: 400, body: { error: 'authorization_declined' } },
      'authorization_declined',
      AccessDeniedError,
    ],
    [
      'access_denied',
      { status: 400, body: { error: 'access_denied' } },
      'access_denied',
      AccessDeniedError,
    ],
    [
      'expired at the IdP',
      { status: 400, body: { error: 'expired_token' } },
      'expired_token',
      DeviceCodeExpiredError,
    ],
    [
      'bad code',
      { status: 400, body: { error: 'bad_verification_code' } },
      'bad_verification_code',
      DeviceCodeExpiredError,
    ],
    [
      'Conditional Access (classified by the CLI)',
      { status: 400, body: { error: 'invalid_grant', error_codes: [53003] } },
      'conditional_access_blocked',
      DeviceCodeBlockedError,
      'AADSTS53003',
    ],
    [
      'anything else',
      { status: 400, body: { error: 'invalid_client' } },
      'other',
      AccessDeniedError,
    ],
    [
      'a non-OAuth body',
      { status: 400, body: { oops: true } },
      'other',
      AccessDeniedError,
      'http_400',
    ],
  ];

  it.each(failureCases)(
    'reports %s before throwing the typed error (AC-4)',
    async (_n, reply, kind, Type, code) => {
      const order: string[] = [];
      const fetch = fakeFetch({
        [`POST ${DEVICE}`]: () => deviceStart,
        [`POST ${IDP_TOKEN}`]: () => reply,
        [`POST ${FAILURES}`]: () => (order.push('reported'), { status: 202 }),
      });
      const signIn = await startIdpDeviceSignIn(cfg, {
        fetch,
        deviceLabel: 'laptop',
        classifyIdpError: (e) =>
          Array.isArray(e.error_codes) && e.error_codes.includes(53003)
            ? { error: 'conditional_access_blocked', idpErrorCode: 'AADSTS53003' }
            : undefined,
      });
      const outcome = signIn.poll().then(
        () => 'resolved',
        (error: unknown) => (order.push('thrown'), error),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const error = await outcome;
      expect(error).toBeInstanceOf(Type);
      expect(AUTH_I18N_KEYS).toContain((error as AccessDeniedError).i18nKey);
      expect(order).toEqual(['reported', 'thrown']);
      const report = JSON.parse(fetch.calls(`POST ${FAILURES}`)[0]?.body ?? '{}') as Record<
        string,
        unknown
      >;
      expect(report).toEqual({
        attempt_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        flow: 'idp_device',
        error: kind,
        device_label: 'laptop',
        ...(code === undefined ? {} : { idp_error_code: code }),
      });
    },
  );

  it('expires locally when the IdP never answers; transient IdP faults back off and are reported as unreachable', async () => {
    const fetch = fakeFetch({
      [`POST ${DEVICE}`]: () => ({ status: 200, body: { ...deviceStart.body, expires_in: 20 } }),
      [`POST ${IDP_TOKEN}`]: () => ({ status: 400, body: { error: 'authorization_pending' } }),
      [`POST ${FAILURES}`]: () => ({ status: 202 }),
    });
    const signIn = await startIdpDeviceSignIn(cfg, { fetch });
    const outcome = signIn.poll().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await outcome).toBeInstanceOf(DeviceCodeExpiredError);
    expect(JSON.parse(fetch.calls(`POST ${FAILURES}`)[0]?.body ?? '{}')).toMatchObject({
      error: 'expired_token',
    });

    const flaky = fakeFetch({
      [`POST ${DEVICE}`]: () => ({ status: 200, body: { ...deviceStart.body, expires_in: 30 } }),
      [`POST ${IDP_TOKEN}`]: () => ({ status: 503 }),
      [`POST ${FAILURES}`]: () => ({ status: 202 }),
    });
    const second = await startIdpDeviceSignIn(cfg, { fetch: flaky });
    const out = second.poll().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await out).toBeInstanceOf(TemporarilyUnavailableError);
    // 5 s, then 10 s, then 20 s: the interval doubles on 5xx.
    expect(flaky.calls(`POST ${IDP_TOKEN}`)).toHaveLength(2);
    expect(JSON.parse(flaky.calls(`POST ${FAILURES}`)[0]?.body ?? '{}')).toMatchObject({
      error: 'other',
      idp_error_code: 'idp_unreachable',
    });
  });

  it('a user cancel stops polling and is not reported; a failing report never replaces the IdP error', async () => {
    const fetch = fakeFetch({
      [`POST ${DEVICE}`]: () => deviceStart,
      [`POST ${IDP_TOKEN}`]: () => ({ status: 400, body: { error: 'authorization_pending' } }),
      [`POST ${FAILURES}`]: () => ({ status: 202 }),
    });
    const controller = new (
      globalThis as unknown as {
        AbortController: new () => { signal: AbortSignalLike; abort(): void };
      }
    ).AbortController();
    const signIn = await startIdpDeviceSignIn(cfg, { fetch });
    const outcome = signIn.poll(controller.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(6_000);
    controller.abort();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(fetch.calls(`POST ${FAILURES}`)).toEqual([]);

    const noReports = fakeFetch({
      [`POST ${DEVICE}`]: () => deviceStart,
      [`POST ${IDP_TOKEN}`]: () => ({ status: 400, body: { error: 'authorization_declined' } }),
      [`POST ${FAILURES}`]: () => Promise.reject(new Error('RTS down')),
    });
    const again = await startIdpDeviceSignIn(cfg, { fetch: noReports });
    const declined = again.poll().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await declined).toBeInstanceOf(AccessDeniedError);
  });

  it('refuses to start when the tenant disabled device code, and reports an IdP refusal at start', async () => {
    await expect(
      startIdpDeviceSignIn({ ...cfg, flows: { idp_device: false, loopback_pkce: true } }),
    ).rejects.toMatchObject({ i18nKey: 'auth.denied.device_code_disabled' });
    const fetch = fakeFetch({
      [`POST ${DEVICE}`]: () => ({ status: 400, body: { error: 'invalid_client' } }),
      [`POST ${FAILURES}`]: () => ({ status: 202 }),
    });
    await expect(startIdpDeviceSignIn(cfg, { fetch })).rejects.toBeInstanceOf(AccessDeniedError);
    expect(fetch.calls(`POST ${FAILURES}`)).toHaveLength(1);
  });

  it('validates the IdP device answer (untrusted input)', async () => {
    for (const body of [
      { ...deviceStart.body, verification_uri: 'javascript:alert(1)' },
      { ...deviceStart.body, user_code: 'AB‮CD' },
      { ...deviceStart.body, expires_in: -1 },
    ]) {
      const fetch = fakeFetch({
        [`POST ${DEVICE}`]: () => ({ status: 200, body }),
        [`POST ${FAILURES}`]: () => ({ status: 202 }),
      });
      await expect(startIdpDeviceSignIn(cfg, { fetch })).rejects.toBeInstanceOf(AuthProtocolError);
    }
  });
});

describe('fetchAuthConfig', () => {
  it('pins the issuer and validates the body', async () => {
    const other = fakeFetch({
      [`GET ${ISSUER}/v1/auth/config`]: () => ({
        status: 200,
        body: { ...cfg, issuer: 'https://evil.example' },
      }),
    });
    await expect(fetchAuthConfig(ISSUER, { fetch: other })).rejects.toMatchObject({
      i18nKey: 'auth.failed.untrusted_issuer',
    });
    const bad = fakeFetch({
      [`GET ${ISSUER}/v1/auth/config`]: () => ({ status: 200, body: { ...cfg, extra: 1 } }),
    });
    await expect(fetchAuthConfig(ISSUER, { fetch: bad })).rejects.toBeInstanceOf(AuthProtocolError);
    const down = fakeFetch({ [`GET ${ISSUER}/v1/auth/config`]: () => ({ status: 503 }) });
    await expect(fetchAuthConfig(ISSUER, { fetch: down })).rejects.toBeInstanceOf(
      TemporarilyUnavailableError,
    );
  });
});

describe('exchange and redemption errors', () => {
  const rts = (reply: { status: number; body?: unknown }) =>
    fakeFetch({ [`POST ${RTS_TOKEN}`]: () => reply });

  it('maps RTS refusals to typed errors with the server’s i18n key when it is a known one', async () => {
    const replay = rts({
      status: 400,
      body: {
        error: 'invalid_grant',
        ralysa_error: { code: 'replay', i18n_key: 'auth.failed.replay' },
      },
    });
    await expect(exchangeIdpToken(cfg, 't', { fetch: replay })).rejects.toMatchObject({
      name: 'AccessDeniedError',
      i18nKey: 'auth.failed.replay',
      reason: 'replay',
    });
    const denied = rts({
      status: 400,
      body: {
        error: 'access_denied',
        ralysa_error: { code: 'not_in_access_group', i18n_key: 'auth.denied.not_in_access_group' },
      },
    });
    await expect(exchangeIdpToken(cfg, 't', { fetch: denied })).rejects.toMatchObject({
      i18nKey: 'auth.denied.not_in_access_group',
    });
    const odd = rts({
      status: 400,
      body: { error: 'access_denied', ralysa_error: { code: 'replay', i18n_key: 'evil.<script>' } },
    });
    await expect(exchangeIdpToken(cfg, 't', { fetch: odd })).rejects.toMatchObject({
      i18nKey: 'auth.error.idp_unavailable',
    });
    const off = rts({ status: 400, body: { error: 'unauthorized_client' } });
    await expect(exchangeIdpToken(cfg, 't', { fetch: off })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    const busy = rts({ status: 503, body: { error: 'temporarily_unavailable' } });
    await expect(exchangeIdpToken(cfg, 't', { fetch: busy })).rejects.toBeInstanceOf(
      TemporarilyUnavailableError,
    );
    const noRefresh = rts({ status: 200, body: { ...rtsTokens.body, refresh_token: undefined } });
    await expect(exchangeIdpToken(cfg, 't', { fetch: noRefresh })).rejects.toBeInstanceOf(
      AuthProtocolError,
    );
  });
});

describe('flow B helpers', () => {
  it('createPkcePair: a 43-character verifier and its S256 challenge (RFC 7636)', async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(base64url(await sha256(utf8(verifier))));
    expect((await createPkcePair()).verifier).not.toBe(verifier);
    // RFC 7636 appendix B vector.
    expect(base64url(await sha256(utf8('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')))).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    expect(createState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('buildAuthorizeUrl: RTS authorize with S256; refuses a non-loopback redirect', async () => {
    const { challenge } = await createPkcePair();
    const state = createState();
    const url = buildAuthorizeUrl(cfg, {
      redirectUri: 'http://127.0.0.1:53123/callback',
      challenge,
      state,
    });
    const [base, query = ''] = url.href.split('?');
    expect(base).toBe(`${ISSUER}/oauth2/authorize`);
    expect(
      Object.fromEntries(query.split('&').map((p) => p.split('=').map(decodeURIComponent))),
    ).toEqual({
      response_type: 'code',
      client_id: 'ralysa-cli',
      redirect_uri: 'http://127.0.0.1:53123/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    for (const redirectUri of ['http://evil.example/callback', 'http://localhost:53123/callback']) {
      expect(() => buildAuthorizeUrl(cfg, { redirectUri, challenge, state })).toThrow();
    }
  });

  it('readAuthorizationCallback: code on matching state; refusals and mismatches are typed', () => {
    const state = createState();
    const code = `rly_ac_${'b'.repeat(43)}`;
    expect(readAuthorizationCallback({ code, state }, state)).toBe(code);
    expect(() => readAuthorizationCallback({ code, state: createState() }, state)).toThrow(
      AuthProtocolError,
    );
    expect(() => readAuthorizationCallback({ code }, state)).toThrow(AuthProtocolError);
    expect(() => readAuthorizationCallback({ code: 'rly_ac_short', state }, state)).toThrow(
      AuthProtocolError,
    );
    try {
      readAuthorizationCallback(
        { error: 'access_denied', error_description: 'not_in_access_group', state },
        state,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AccessDeniedError);
      expect(error).toMatchObject({
        i18nKey: 'auth.denied.not_in_access_group',
        reason: 'not_in_access_group',
      });
    }
    expect(() =>
      readAuthorizationCallback(
        { error: 'access_denied', error_description: '<b>x</b>', state },
        state,
      ),
    ).toThrow(expect.objectContaining({ i18nKey: 'auth.failed.idp_error' }) as Error);
  });

  it('redeemAuthorizationCode posts the code, redirect and verifier; revokeSession posts the refresh token', async () => {
    const fetch = fakeFetch({
      [`POST ${RTS_TOKEN}`]: () => rtsTokens,
      [`POST ${ISSUER}/oauth2/revoke`]: () => ({ status: 200, body: {} }),
    });
    const { verifier } = await createPkcePair();
    const code = `rly_ac_${'c'.repeat(43)}`;
    const tokens = await redeemAuthorizationCode(
      cfg,
      { code, redirectUri: 'http://127.0.0.1:53123/callback', verifier },
      { fetch },
    );
    expect(tokens.refreshToken).toBe(RT);
    expect(fetch.calls(`POST ${RTS_TOKEN}`)[0]?.form).toEqual({
      grant_type: 'authorization_code',
      client_id: 'ralysa-cli',
      code,
      redirect_uri: 'http://127.0.0.1:53123/callback',
      code_verifier: verifier,
    });
    await expect(
      redeemAuthorizationCode(cfg, { code: 'bad', redirectUri: 'x', verifier }, { fetch }),
    ).rejects.toBeInstanceOf(AuthProtocolError);

    await revokeSession(cfg, RT, { fetch });
    expect(fetch.calls(`POST ${ISSUER}/oauth2/revoke`)[0]?.form).toEqual({
      client_id: 'ralysa-cli',
      token: RT,
      token_type_hint: 'refresh_token',
    });
    const down = fakeFetch({ [`POST ${ISSUER}/oauth2/revoke`]: () => ({ status: 503 }) });
    await expect(revokeSession(cfg, RT, { fetch: down })).rejects.toBeInstanceOf(
      TemporarilyUnavailableError,
    );
    const refused = fakeFetch({
      [`POST ${ISSUER}/oauth2/revoke`]: () => ({ status: 401, body: { error: 'invalid_client' } }),
    });
    await expect(revokeSession(cfg, RT, { fetch: refused })).rejects.not.toBeInstanceOf(
      SessionRevokedError,
    );
  });
});
