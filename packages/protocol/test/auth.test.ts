// @ralysa/protocol/auth: claims, headers, OAuth contracts and reason codes (F-002 design §3.2, §3.3,
// §3.9; AC-3; SEC-F002-19).
import { describe, expect, it } from 'vitest';
import {
  AUTH_I18N_KEYS,
  AccessTokenHeader,
  Audience,
  AuthorizationCodeRequest,
  AuthorizeQuery,
  FORBIDDEN_JOSE_HEADERS,
  OAuthError,
  RalysaErrorCode,
  RefreshReason,
  RefreshRequest,
  RevokeRequest,
  ServiceAccessTokenClaims,
  SignInReason,
  TOKEN_EXCHANGE_GRANT,
  TokenExchangeRequest,
  TokenRejectReason,
  TokenRequest,
  UserAccessTokenClaims,
  kidFor,
  kidPattern,
  refreshI18nKey,
  signInI18nKey,
} from '../src/auth/index.js';

const now = 1_790_000_000;
const userClaims = {
  iss: 'https://cp.example.test',
  aud: 'model-gateway',
  sub: '0192f0a0-7b3c-7d4e-8f00-0000000000aa',
  client_id: 'ralysa-cli',
  tid: '0192f0a0-7b3c-7d4e-8f00-00000000000f',
  sid: '0192f0a0-7b3c-7d4e-8f00-0000000000bb',
  idp_sub: '4f1c2e3d-0000-4000-8000-000000000001',
  surface: 'cli',
  amr: ['pwd', 'mfa'],
  auth_time: now,
  region: 'qa-doha-1',
  token_use: 'access',
  iat: now,
  nbf: now,
  exp: now + 900,
  jti: '0192f0a0-7b3c-7d4e-8f00-0000000000cc',
};

describe('access-token header and claims (§3.2.2)', () => {
  it('accepts the ES256 at+jwt header and keeps unknown members for the forbidden-header check', () => {
    const header = { alg: 'ES256', typ: 'at+jwt', kid: 'ralysa-rts-signing.v1', jku: 'x' };
    expect(AccessTokenHeader.parse(header)).toEqual(header);
    expect(FORBIDDEN_JOSE_HEADERS).toEqual(['jku', 'jwk', 'x5u', 'x5c', 'crit']);
  });

  it.each(['none', 'HS256', 'RS256', 'ES384'])('refuses alg %s', (alg) => {
    expect(AccessTokenHeader.safeParse({ alg, typ: 'at+jwt', kid: 'k' }).success).toBe(false);
  });

  it('refuses typ JWT', () => {
    expect(AccessTokenHeader.safeParse({ alg: 'ES256', typ: 'JWT', kid: 'k' }).success).toBe(false);
  });

  it('builds and matches kid values from the configured signing key', () => {
    const pattern = kidPattern('ralysa-rts-signing');
    expect(kidFor('ralysa-rts-signing', 3)).toBe('ralysa-rts-signing.v3');
    expect(pattern.test('ralysa-rts-signing.v3')).toBe(true);
    for (const kid of [
      'ralysa-rts-signing.v0',
      'ralysa-rts-signing.v',
      'other.v1',
      'ralysa-rts-signing.v1x',
    ]) {
      expect(pattern.test(kid)).toBe(false);
    }
    expect(() => kidPattern('bad.name')).toThrow();
    expect(() => kidFor('ralysa-rts-signing', 0)).toThrow();
  });

  it('accepts user claims with exactly one audience and ignores unknown claims', () => {
    expect(UserAccessTokenClaims.safeParse({ ...userClaims, future_claim: 1 }).success).toBe(true);
  });

  it('refuses an array audience, a wrong token_use and a non-UUID subject', () => {
    expect(UserAccessTokenClaims.safeParse({ ...userClaims, aud: ['model-gateway'] }).success).toBe(
      false,
    );
    expect(UserAccessTokenClaims.safeParse({ ...userClaims, token_use: 'service' }).success).toBe(
      false,
    );
    expect(UserAccessTokenClaims.safeParse({ ...userClaims, sub: 'alice' }).success).toBe(false);
  });

  it('service tokens are for the control plane only, with an svc: subject', () => {
    const claims = {
      iss: 'https://cp.example.test',
      aud: 'control-plane',
      sub: 'svc:model-gateway',
      client_id: 'model-gateway',
      tid: userClaims.tid,
      token_use: 'service',
      iat: now,
      nbf: now,
      exp: now + 300,
      jti: userClaims.jti,
    };
    expect(ServiceAccessTokenClaims.safeParse(claims).success).toBe(true);
    expect(ServiceAccessTokenClaims.safeParse({ ...claims, aud: 'model-gateway' }).success).toBe(
      false,
    );
    expect(ServiceAccessTokenClaims.safeParse({ ...claims, sub: 'model-gateway' }).success).toBe(
      false,
    );
  });

  it('lists the five audiences and every rejection reason', () => {
    expect(Audience.options).toHaveLength(5);
    expect(TokenRejectReason.options).toContain('forbidden_header');
    expect(TokenRejectReason.options).toContain('issued_in_future');
    expect(TokenRejectReason.options).toContain('governance_stale');
  });
});

describe('OAuth contracts (§3.3, AC-3)', () => {
  const verifier = 'a'.repeat(43);
  const code = `rly_ac_${'A'.repeat(43)}`;
  const refresh = `rly_rt_${'b'.repeat(43)}`;

  it('accepts IP-literal loopback redirects only (RFC 8252 §7.3)', () => {
    const base = {
      response_type: 'code',
      client_id: 'ralysa-cli',
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
      state: 's'.repeat(16),
    };
    for (const uri of ['http://127.0.0.1:53123/callback', 'http://[::1]:8080/callback']) {
      expect(AuthorizeQuery.safeParse({ ...base, redirect_uri: uri }).success).toBe(true);
    }
    for (const uri of [
      'http://localhost:53123/callback',
      'https://127.0.0.1:53123/callback',
      'http://127.0.0.1:0/callback',
      'http://127.0.0.1:53123/other',
      'http://127.0.0.1.evil.test:1/callback',
    ]) {
      expect(AuthorizeQuery.safeParse({ ...base, redirect_uri: uri }).success).toBe(false);
    }
    expect(
      AuthorizeQuery.safeParse({
        ...base,
        redirect_uri: 'http://127.0.0.1:1/callback',
        code_challenge_method: 'plain',
      }).success,
    ).toBe(false);
  });

  it('dispatches the four grants and refuses password and unknown grants', () => {
    const exchange = {
      grant_type: TOKEN_EXCHANGE_GRANT,
      client_id: 'ralysa-cli',
      subject_token: 'eyJ.x.y',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    };
    for (const body of [
      {
        grant_type: 'authorization_code',
        client_id: 'ralysa-cli',
        code,
        redirect_uri: 'http://127.0.0.1:1/callback',
        code_verifier: verifier,
      },
      {
        grant_type: 'refresh_token',
        client_id: 'ralysa-cli',
        refresh_token: refresh,
        audience: 'model-gateway',
      },
      exchange,
      {
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: 'eyJ.a.b',
      },
    ]) {
      expect(TokenRequest.safeParse(body).success).toBe(true);
    }
    for (const grant of ['password', 'implicit', 'urn:ietf:params:oauth:grant-type:device_code']) {
      expect(
        TokenRequest.safeParse({
          grant_type: grant,
          client_id: 'ralysa-cli',
          username: 'u',
          password: 'p',
        }).success,
      ).toBe(false);
    }
  });

  it('user clients are public: a client_secret is refused on every user grant', () => {
    expect(
      RefreshRequest.safeParse({
        grant_type: 'refresh_token',
        client_id: 'ralysa-cli',
        refresh_token: refresh,
        client_secret: 'x',
      }).success,
    ).toBe(false);
    expect(
      AuthorizationCodeRequest.safeParse({
        grant_type: 'authorization_code',
        client_id: 'ralysa-cli',
        code,
        redirect_uri: 'x',
        code_verifier: verifier,
        client_secret: 'x',
      }).success,
    ).toBe(false);
    expect(
      RevokeRequest.safeParse({ client_id: 'ralysa-cli', token: refresh, client_secret: 'x' })
        .success,
    ).toBe(false);
  });

  it('refuses malformed opaque tokens and verifiers', () => {
    expect(
      RefreshRequest.safeParse({
        grant_type: 'refresh_token',
        client_id: 'ralysa-cli',
        refresh_token: 'rly_rt_short',
      }).success,
    ).toBe(false);
    expect(
      AuthorizationCodeRequest.safeParse({
        grant_type: 'authorization_code',
        client_id: 'ralysa-cli',
        code: `rly_rt_${'A'.repeat(43)}`,
        redirect_uri: 'x',
        code_verifier: verifier,
      }).success,
    ).toBe(false);
    expect(
      AuthorizationCodeRequest.safeParse({
        grant_type: 'authorization_code',
        client_id: 'ralysa-cli',
        code,
        redirect_uri: 'x',
        code_verifier: 'short',
      }).success,
    ).toBe(false);
  });

  it('token exchange limits the subject token and the device label', () => {
    const base = {
      grant_type: TOKEN_EXCHANGE_GRANT,
      client_id: 'ralysa-cli',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    };
    expect(
      TokenExchangeRequest.safeParse({ ...base, subject_token: 'x'.repeat(8193) }).success,
    ).toBe(false);
    expect(
      TokenExchangeRequest.safeParse({ ...base, subject_token: 'x', device_label: 'd'.repeat(65) })
        .success,
    ).toBe(false);
  });

  it('OAuthError carries a ralysa_error for sign-in and refresh reasons', () => {
    expect(
      OAuthError.parse({
        error: 'access_denied',
        ralysa_error: { code: 'not_in_access_group', i18n_key: 'auth.denied.not_in_access_group' },
      }).ralysa_error?.code,
    ).toBe('not_in_access_group');
    expect(
      OAuthError.safeParse({
        error: 'invalid_grant',
        ralysa_error: { code: 'idp_session_revoked', i18n_key: 'auth.denied.idp_session_revoked' },
      }).success,
    ).toBe(true);
    expect(OAuthError.safeParse({ error: 'server_error' }).success).toBe(false);
  });
});

describe('reason codes and i18n keys (§3.9)', () => {
  it('maps each sign-in reason to its outcome category [AR-3]', () => {
    expect(signInI18nKey('not_in_access_group')).toBe('auth.denied.not_in_access_group');
    expect(signInI18nKey('admin_requires_strong_flow')).toBe(
      'auth.denied.admin_requires_strong_flow',
    );
    expect(signInI18nKey('replay')).toBe('auth.failed.replay');
    expect(signInI18nKey('idp_unavailable')).toBe('auth.error.idp_unavailable');
    expect(signInI18nKey('group_overage_unresolved')).toBe('auth.error.group_overage_unresolved');
    expect(refreshI18nKey('reuse_detected')).toBe('auth.denied.reuse_detected');
  });

  it('covers the §3.5 catalogue', () => {
    expect(SignInReason.options).toHaveLength(15);
    expect(RefreshReason.options).toHaveLength(7);
    expect(new Set(RalysaErrorCode.options).size).toBe(RalysaErrorCode.options.length);
    for (const reason of [...SignInReason.options, ...RefreshReason.options]) {
      expect(RalysaErrorCode.options).toContain(reason);
    }
  });

  it('exports a sorted, unique key list including the server-rendered authorize error', () => {
    expect(AUTH_I18N_KEYS).toContain('auth.error.invalid_authorize_request');
    expect(AUTH_I18N_KEYS).toContain('auth.failed.expired');
    expect(AUTH_I18N_KEYS).toContain('auth.denied.expired');
    expect([...AUTH_I18N_KEYS].sort()).toEqual(AUTH_I18N_KEYS);
    expect(new Set(AUTH_I18N_KEYS).size).toBe(AUTH_I18N_KEYS.length);
    for (const key of AUTH_I18N_KEYS) expect(key).toMatch(/^auth\.(denied|failed|error)\.[a-z_]+$/);
  });
});
