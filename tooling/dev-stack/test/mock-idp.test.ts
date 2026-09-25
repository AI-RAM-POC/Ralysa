// F-002-T09: the mock IdP (design §8.3; SEC-F002-13 d/e). The mock runs in-process on ephemeral
// loopback ports, as the integration tests will start it.
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_GROUP_NAME,
  FATIMA_NAME,
  GRAPH_RESOURCE,
  type MockIdp,
  approveDeviceCode,
  signInAtAuthorize,
  startMockIdp,
} from '../src/mock-idp/index.ts';
import type { MockBrowserError } from '../src/mock-idp/browser.ts';
import { OLGA_GROUP_COUNT } from '../src/mock-idp/fixtures.ts';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const REDIRECT_URI = 'http://127.0.0.1:4100/oauth2/idp/callback';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let idp: MockIdp;

beforeAll(async () => {
  idp = await startMockIdp({ deviceCodeTtlSeconds: 10, rtsRedirectUris: [REDIRECT_URI] });
});
afterAll(async () => {
  await idp.close();
});
afterEach(() => {
  idp.setGraphFault({ mode: 'none' });
});

type Json = Record<string, unknown>;

async function postForm(
  url: string,
  form: Record<string, string>,
): Promise<{ status: number; body: Json }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

async function control(method: string, path: string, body?: unknown, token = idp.control.token) {
  const response = await fetch(`${idp.control.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as Json };
}

const decodeJwtPayload = (jwt: string): Json =>
  JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Json;

async function verify(token: string, audience: string): Promise<JWTPayload> {
  const jwks = createRemoteJWKSet(new URL(idp.endpoints.jwks));
  const { payload } = await jwtVerify(token, jwks, {
    issuer: idp.issuer,
    audience,
    algorithms: ['RS256'],
  });
  return payload;
}

async function deviceSignIn(username: string): Promise<Json> {
  const start = await postForm(idp.endpoints.deviceAuthorization, {
    client_id: idp.cliClientId,
    scope: idp.signinScope,
  });
  expect(start.status).toBe(200);
  await approveDeviceCode({
    verificationUri: String(start.body.verification_uri),
    userCode: String(start.body.user_code),
    username,
  });
  const token = await postForm(idp.endpoints.token, {
    grant_type: DEVICE_GRANT,
    client_id: idp.cliClientId,
    device_code: String(start.body.device_code),
  });
  expect(token.status).toBe(200);
  return token.body;
}

/** Flow B end to end for `username`: the token response. */
async function codeSignIn(username: string, nonce: string): Promise<Json> {
  const { verifier, challenge } = pkcePair();
  const redirect = await signInAtAuthorize({
    authorizationUrl: authorizeUrl(challenge, undefined, undefined, nonce),
    username,
  });
  const token = await postForm(idp.endpoints.token, {
    grant_type: 'authorization_code',
    client_id: idp.rtsClientId,
    client_secret: idp.clientSecret,
    code: String(redirect.searchParams.get('code')),
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  expect(token.status).toBe(200);
  return token.body;
}

const pkcePair = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

function authorizeUrl(
  challenge: string | undefined,
  state = randomBytes(8).toString('hex'),
  scope = `openid profile email ${idp.signinScope}`,
  nonce = randomBytes(8).toString('hex'),
): string {
  const url = new URL(idp.endpoints.authorization);
  url.searchParams.set('client_id', idp.rtsClientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  if (challenge !== undefined) {
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

async function graphToken(secret = idp.clientSecret) {
  return postForm(idp.endpoints.token, {
    grant_type: 'client_credentials',
    client_id: idp.rtsClientId,
    client_secret: secret,
    scope: `${GRAPH_RESOURCE}/.default`,
  });
}

async function graph(method: string, path: string, body?: unknown, bearer?: string) {
  const token = bearer ?? String((await graphToken()).body.access_token);
  const started = performance.now();
  const response = await fetch(`${idp.graphBaseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(2_000),
  });
  return {
    status: response.status,
    body: (await response.json()) as Json,
    ms: performance.now() - started,
  };
}

describe('discovery and keys', () => {
  it('serves Entra-shaped discovery with only the grants the mock needs', async () => {
    const response = await fetch(idp.endpoints.discovery);
    const doc = (await response.json()) as Json;
    expect(doc.issuer).toBe(idp.issuer);
    expect(idp.issuer).toBe(`${idp.baseUrl}/${idp.tenantId}/v2.0`);
    expect(doc.token_endpoint).toBe(idp.endpoints.token);
    expect(doc.authorization_endpoint).toBe(idp.endpoints.authorization);
    expect(doc.device_authorization_endpoint).toBe(idp.endpoints.deviceAuthorization);
    expect(doc.jwks_uri).toBe(idp.endpoints.jwks);
    expect(doc.grant_types_supported).not.toContain('password');
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('generates its signing key per run: RS256, never the same twice [SEC-F002-13 d]', async () => {
    const other = await startMockIdp();
    try {
      const keys = async (m: MockIdp) =>
        ((await (await fetch(m.endpoints.jwks)).json()) as { keys: Json[] }).keys;
      const [mine, theirs] = await Promise.all([keys(idp), keys(other)]);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
      expect(mine[0]).not.toHaveProperty('d');
      expect(mine[0]?.n).not.toBe(theirs[0]?.n);
      expect(mine[0]?.kid).not.toBe(theirs[0]?.kid);
      expect(other.control.token).not.toBe(idp.control.token);
      expect(other.clientSecret).not.toBe(idp.clientSecret);
    } finally {
      await other.close();
    }
  });

  it('refuses the password grant', async () => {
    const result = await postForm(idp.endpoints.token, {
      grant_type: 'password',
      client_id: idp.rtsClientId,
      client_secret: idp.clientSecret,
      username: 'alice',
      password: 'x',
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('unsupported_grant_type');
  });
});

describe('device flow (flow A)', () => {
  it('issues an Entra v2-shaped RS256 access token for the RTS resource', async () => {
    const body = await deviceSignIn('alice');
    const token = String(body.access_token);
    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe('RS256');
    expect(header.typ).toBe('JWT');
    expect(typeof header.kid).toBe('string');

    const claims = await verify(token, idp.rtsClientId);
    const alice = idp.user('alice');
    expect(claims).toMatchObject({
      ver: '2.0',
      tid: idp.tenantId,
      oid: alice.oid,
      azp: idp.cliClientId,
      azpacr: '0',
      scp: 'Ralysa.SignIn',
      name: 'Alice',
      preferred_username: 'alice@contoso.example',
      amr: ['pwd', 'mfa'],
      ipaddr: '127.0.0.1',
      groups: [idp.accessGroupId],
    });
    expect(claims.uti).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(claims.sub).not.toBe(alice.oid);
    expect(claims.nbf).toBe(claims.iat);
  });

  it('answers authorization_pending before approval, and refuses a used device code', async () => {
    const start = await postForm(idp.endpoints.deviceAuthorization, {
      client_id: idp.cliClientId,
      scope: idp.signinScope,
    });
    expect(start.body).toMatchObject({ expires_in: 10, interval: 5 });
    expect(start.body.message).toContain(String(start.body.user_code));
    expect(start.body).not.toHaveProperty('verification_uri_complete');
    expect(String(start.body.verification_uri)).toBe(idp.endpoints.deviceVerification);
    const poll = () =>
      postForm(idp.endpoints.token, {
        grant_type: DEVICE_GRANT,
        client_id: idp.cliClientId,
        device_code: String(start.body.device_code),
      });
    expect((await poll()).body.error).toBe('authorization_pending');
    await approveDeviceCode({
      verificationUri: String(start.body.verification_uri),
      userCode: String(start.body.user_code),
      username: 'bob',
    });
    expect((await poll()).status).toBe(200);
    expect((await poll()).body.error).toBe('invalid_grant');
  });

  it('expires the device code after its lifetime', async () => {
    const short = await startMockIdp({ deviceCodeTtlSeconds: 1 });
    try {
      const start = await postForm(short.endpoints.deviceAuthorization, {
        client_id: short.cliClientId,
        scope: short.signinScope,
      });
      // Step the clock past the lifetime instead of sleeping (oidc-provider reads Date.now()).
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
      vi.setSystemTime(Date.now() + 1_500);
      const poll = await postForm(short.endpoints.token, {
        grant_type: DEVICE_GRANT,
        client_id: short.cliClientId,
        device_code: String(start.body.device_code),
      });
      expect(poll.body.error).toBe('expired_token');
    } finally {
      vi.useRealTimers();
      await short.close();
    }
  });

  it('refuses a disabled user (carol): the poll answers access_denied', async () => {
    const start = await postForm(idp.endpoints.deviceAuthorization, {
      client_id: idp.cliClientId,
      scope: idp.signinScope,
    });
    await approveDeviceCode({
      verificationUri: String(start.body.verification_uri),
      userCode: String(start.body.user_code),
      username: 'carol',
    }).catch(() => undefined);
    const poll = await postForm(idp.endpoints.token, {
      grant_type: DEVICE_GRANT,
      client_id: idp.cliClientId,
      device_code: String(start.body.device_code),
    });
    expect(poll.body.error).toBe('access_denied');
  });

  it('is not open to the confidential RTS client', async () => {
    const start = await postForm(idp.endpoints.deviceAuthorization, {
      client_id: idp.rtsClientId,
      client_secret: idp.clientSecret,
      scope: idp.signinScope,
    });
    expect(start.status).toBe(400);
  });
});

describe('authorization code + PKCE (flow B)', () => {
  it('signs in by username and redeems the code with the verifier and a client secret', async () => {
    const { verifier, challenge } = pkcePair();
    const redirect = await signInAtAuthorize({
      authorizationUrl: authorizeUrl(challenge, 'state-1'),
      username: 'fatima',
    });
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get('state')).toBe('state-1');
    expect(redirect.searchParams.get('iss')).toBe(idp.issuer);
    const code = redirect.searchParams.get('code');
    expect(code).toEqual(expect.any(String));

    const token = await postForm(idp.endpoints.token, {
      grant_type: 'authorization_code',
      client_id: idp.rtsClientId,
      client_secret: idp.clientSecret,
      code: String(code),
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(token.status).toBe(200);
    const access = await verify(String(token.body.access_token), idp.rtsClientId);
    expect(access).toMatchObject({
      oid: idp.user('fatima').oid,
      azp: idp.rtsClientId,
      azpacr: '1',
    });
    // Arabic display name with harakat, byte for byte.
    expect(access.name).toBe(FATIMA_NAME);
    const id = await verify(String(token.body.id_token), idp.rtsClientId);
    expect(id).toMatchObject({ oid: idp.user('fatima').oid, tid: idp.tenantId, name: FATIMA_NAME });
  });

  it('issues an Entra v2-shaped ID token: typ JWT, pairwise sub, uti, ver, amr/acrs, ipaddr', async () => {
    const nonce = randomBytes(8).toString('hex');
    const body = await codeSignIn('erin', nonce);
    const idToken = String(body.id_token);
    const header = decodeProtectedHeader(idToken);
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(typeof header.kid).toBe('string');
    const claims = await verify(idToken, idp.rtsClientId);
    const erin = idp.user('erin');
    expect(claims).toMatchObject({
      ver: '2.0',
      tid: idp.tenantId,
      oid: erin.oid,
      amr: ['fido'],
      acrs: ['c1'],
      ipaddr: '127.0.0.1',
      nonce,
      groups: [idp.accessGroupId, idp.adminGroupId],
    });
    expect(claims.sub).not.toBe(erin.oid);
    expect(claims.uti).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // The access token of the same response uses another uti.
    const access = await verify(String(body.access_token), idp.rtsClientId);
    expect(access.uti).not.toBe(claims.uti);
    // An MFA user: amr pwd+mfa, no acrs.
    const alice = await verify(
      String((await codeSignIn('alice', nonce)).id_token),
      idp.rtsClientId,
    );
    expect(alice.amr).toEqual(['pwd', 'mfa']);
    expect(alice).not.toHaveProperty('acrs');
  });

  it('refuses scopes for two resources (RTS API and Graph) in one request', async () => {
    const result = await signInAtAuthorize({
      authorizationUrl: authorizeUrl(
        pkcePair().challenge,
        undefined,
        `openid ${idp.signinScope} ${GRAPH_RESOURCE}/.default`,
      ),
      username: 'alice',
    }).catch((error: unknown) => error);
    const refused =
      result instanceof URL
        ? result.searchParams.get('error')
        : (result as MockBrowserError).pageError;
    expect(refused).toBe('invalid_scope');
  });

  it('refuses a device-flow request for Graph (no delegated Graph tokens)', async () => {
    const start = await postForm(idp.endpoints.deviceAuthorization, {
      client_id: idp.cliClientId,
      scope: `${GRAPH_RESOURCE}/.default`,
    });
    expect(start.status).toBe(400);
    expect(start.body.error).toBe('invalid_target');
  });

  it('requires PKCE', async () => {
    const redirect = await signInAtAuthorize({
      authorizationUrl: authorizeUrl(undefined),
      username: 'alice',
    }).catch((error: unknown) => error);
    const refused =
      redirect instanceof URL
        ? redirect.searchParams.get('error')
        : (redirect as MockBrowserError).pageError;
    expect(refused).toBe('invalid_request');
  });

  it('refuses a wrong code verifier (without consuming the code) and a reused code', async () => {
    const { verifier, challenge } = pkcePair();
    const redirect = await signInAtAuthorize({
      authorizationUrl: authorizeUrl(challenge),
      username: 'alice',
    });
    const redeem = (codeVerifier: string) =>
      postForm(idp.endpoints.token, {
        grant_type: 'authorization_code',
        client_id: idp.rtsClientId,
        client_secret: idp.clientSecret,
        code: String(redirect.searchParams.get('code')),
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
      });
    expect((await redeem(pkcePair().verifier)).body.error).toBe('invalid_grant');
    expect((await redeem(verifier)).status).toBe(200);
    expect((await redeem(verifier)).body.error).toBe('invalid_grant');
  });

  it('redirects a disabled user back with access_denied', async () => {
    const redirect = await signInAtAuthorize({
      authorizationUrl: authorizeUrl(pkcePair().challenge),
      username: 'carol',
    });
    expect(redirect.searchParams.get('error')).toBe('access_denied');
  });

  it('shows a login page with a username field and no password field', async () => {
    const response = await fetch(authorizeUrl(pkcePair().challenge), { redirect: 'manual' });
    const login = await fetch(new URL(String(response.headers.get('location')), idp.baseUrl), {
      headers: {
        cookie: response.headers
          .getSetCookie()
          .map((c) => c.split(';')[0])
          .join('; '),
      },
    });
    const html = await login.text();
    expect(html).toContain('name="username"');
    expect(html).not.toMatch(/type="password"|name="pass/i);
  });
});

describe('client secrets', () => {
  it('accepts two secrets at once and refuses one after it is removed', async () => {
    const added = await control('POST', '/client-secrets');
    expect(added.status).toBe(201);
    const second = String(added.body.secret);
    expect((await graphToken(idp.clientSecret)).status).toBe(200);
    expect((await graphToken(second)).status).toBe(200);

    expect((await control('DELETE', '/client-secrets', { secret: idp.clientSecret })).status).toBe(
      200,
    );
    const refused = await graphToken(idp.clientSecret);
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe('invalid_client');
    expect((await graphToken(second)).status).toBe(200);

    // Restore the first secret for the other tests.
    idp.state.secrets.add(idp.clientSecret);
    expect((await control('DELETE', '/client-secrets', { secret: second })).status).toBe(200);
    expect((await control('DELETE', '/client-secrets', { secret: second })).status).toBe(404);
  });

  it('client credentials: only Graph, only with /.default; the token is Entra v1 (sts.windows.net)', async () => {
    const graphTokenBody = (await graphToken()).body;
    const claims = decodeJwtPayload(String(graphTokenBody.access_token));
    expect(claims).toMatchObject({
      aud: GRAPH_RESOURCE,
      iss: `https://sts.windows.net/${idp.tenantId}/`,
      ver: '1.0',
      idtyp: 'app',
      appid: idp.rtsClientId,
    });
    for (const scope of [idp.signinScope, `${GRAPH_RESOURCE}/User.Read.All`]) {
      const refused = await postForm(idp.endpoints.token, {
        grant_type: 'client_credentials',
        client_id: idp.rtsClientId,
        client_secret: idp.clientSecret,
        scope,
      });
      expect(refused.status, scope).toBe(400);
      expect(refused.body.error, scope).toBe('invalid_scope');
    }
  });

  it('client credentials without a scope is invalid_scope, as Entra (AADSTS900144) (R27-N7)', async () => {
    const refused = await postForm(idp.endpoints.token, {
      grant_type: 'client_credentials',
      client_id: idp.rtsClientId,
      client_secret: idp.clientSecret,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_scope');
    expect(refused.body.access_token).toBeUndefined();
  });

  it('refuses a wrong secret', async () => {
    expect((await graphToken('not-the-secret')).status).toBe(401);
  });
});

describe('fixture claim shapes', () => {
  it('olga (250 groups) gets overage markers instead of groups', async () => {
    const claims = await verify(idp.mintAccessToken('olga'), idp.rtsClientId);
    expect(claims.groups).toBeUndefined();
    const olga = idp.user('olga');
    expect(olga.groups).toHaveLength(OLGA_GROUP_COUNT);
    expect(claims._claim_names).toEqual({ groups: 'src1' });
    expect(claims._claim_sources).toEqual({
      src1: { endpoint: `${idp.graphBaseUrl}/v1.0/users/${olga.oid}/getMemberObjects` },
    });
  });

  it('also in a device-flow token', async () => {
    const body = await deviceSignIn('olga');
    const claims = await verify(String(body.access_token), idp.rtsClientId);
    expect(claims.groups).toBeUndefined();
    expect(claims._claim_names).toEqual({ groups: 'src1' });
  });

  it('sam carries an on-prem group name; Graph still reports the access group by object id', async () => {
    const claims = await verify(idp.mintAccessToken('sam'), idp.rtsClientId);
    expect(claims.groups).toEqual(['CONTOSO\\Ralysa Users']);
    const check = await graph('POST', `/v1.0/users/${idp.user('sam').oid}/checkMemberGroups`, {
      groupIds: [idp.accessGroupId],
    });
    expect(check.body.value).toEqual([idp.accessGroupId]);
  });

  it('mallory is in a look-alike group: same display name, another object id', async () => {
    const [groupId] = idp.user('mallory').groups;
    expect(groupId).toMatch(GUID);
    expect(groupId).not.toBe(idp.accessGroupId);
    const group = await graph('GET', `/v1.0/groups/${String(groupId)}`);
    expect(group.body.displayName).toBe(ACCESS_GROUP_NAME);
    const claims = await verify(idp.mintAccessToken('mallory'), idp.rtsClientId);
    expect(claims.groups).toEqual([groupId]);
  });

  it('dana is admin only, erin is both and signs in with FIDO', async () => {
    const dana = await verify(idp.mintAccessToken('dana'), idp.rtsClientId);
    expect(dana.groups).toEqual([idp.adminGroupId]);
    const erin = await verify((await deviceSignIn('erin')).access_token as string, idp.rtsClientId);
    expect(erin.groups).toEqual([idp.accessGroupId, idp.adminGroupId]);
    expect(erin.amr).toEqual(['fido']);
    expect(erin.acrs).toEqual(['c1']);
  });

  it('fatima is in an Arabic-named group', async () => {
    const [, arabicGroup] = idp.user('fatima').groups;
    const group = await graph('GET', `/v1.0/groups/${String(arabicGroup)}`);
    expect(group.body.displayName).toBe('فَرِيقُ المالِيَّة');
  });

  it('every fixture group id is a GUID; bob has none', () => {
    for (const user of idp.state.users.values()) {
      for (const group of user.groups) expect(group).toMatch(GUID);
    }
    expect(idp.user('bob').groups).toEqual([]);
  });
});

describe('Graph stub', () => {
  it('reports a user, and moves signInSessionsValidFromDateTime on "revoke sessions"', async () => {
    const alice = idp.user('alice');
    const before = await graph('GET', `/v1.0/users/${alice.oid}`);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ id: alice.oid, accountEnabled: true });
    const revoked = await control('POST', '/users/alice/revoke-sessions');
    expect(revoked.status).toBe(200);
    const after = await graph('GET', `/v1.0/users/${alice.oid}`);
    expect(after.body.signInSessionsValidFromDateTime).toBe(
      revoked.body.signInSessionsValidFromDateTime,
    );
    expect(Date.parse(String(after.body.signInSessionsValidFromDateTime))).toBeGreaterThan(
      Date.parse(String(before.body.signInSessionsValidFromDateTime)),
    );
  });

  it('answers 404 for a deleted user (dora), with Graph error shape', async () => {
    const result = await graph('GET', `/v1.0/users/${idp.user('dora').oid}`);
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'Request_ResourceNotFound' } });
    const check = await graph('POST', `/v1.0/users/${idp.user('dora').oid}/checkMemberGroups`, {
      groupIds: [idp.accessGroupId],
    });
    expect(check.status).toBe(404);
  });

  it('reports a disabled user (carol) as accountEnabled=false', async () => {
    const result = await graph('GET', `/v1.0/users/${idp.user('carol').oid}`);
    expect(result.body.accountEnabled).toBe(false);
  });

  it('checkMemberGroups returns only the groups the user is in, and validates the body', async () => {
    const bob = idp.user('bob');
    const erin = idp.user('erin');
    const ids = [idp.accessGroupId, idp.adminGroupId];
    expect(
      (await graph('POST', `/v1.0/users/${bob.oid}/checkMemberGroups`, { groupIds: ids })).body
        .value,
    ).toEqual([]);
    expect(
      (await graph('POST', `/v1.0/users/${erin.oid}/checkMemberGroups`, { groupIds: ids })).body
        .value,
    ).toEqual(ids);
    expect(
      (await graph('POST', `/v1.0/users/${erin.oid}/checkMemberGroups`, { groupIds: [] })).status,
    ).toBe(400);
  });

  it('getMemberObjects lists all 250 of olga’s groups', async () => {
    const result = await graph('POST', `/v1.0/users/${idp.user('olga').oid}/getMemberObjects`, {
      securityEnabledOnly: true,
    });
    expect(result.body.value).toHaveLength(OLGA_GROUP_COUNT);
  });

  it('refuses a missing token and a user (non-app) token', async () => {
    const none = await fetch(`${idp.graphBaseUrl}/v1.0/users/${idp.user('alice').oid}`);
    expect(none.status).toBe(401);
    const user = await graph(
      'GET',
      `/v1.0/users/${idp.user('alice').oid}`,
      undefined,
      idp.mintAccessToken('alice'),
    );
    expect(user.status).toBe(401);
  });

  it('injects an error status through the fault toggle', async () => {
    expect((await control('PUT', '/graph-fault', { mode: 'error', status: 503 })).status).toBe(200);
    const result = await graph('GET', `/v1.0/users/${idp.user('alice').oid}`);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: { code: 'serviceNotAvailable' } });
    await control('PUT', '/graph-fault', { mode: 'none' });
    expect((await graph('GET', `/v1.0/users/${idp.user('alice').oid}`)).status).toBe(200);
  });

  it('adds latency through the toggle', async () => {
    const token = String((await graphToken()).body.access_token);
    await control('PUT', '/graph-fault', { mode: 'none', latencyMs: 300 });
    const slow = await graph('GET', `/v1.0/users/${idp.user('alice').oid}`, undefined, token);
    expect(slow.status).toBe(200);
    expect(slow.ms).toBeGreaterThanOrEqual(290);
  });

  it('hangs until the client gives up, and releases on reset', async () => {
    const token = String((await graphToken()).body.access_token);
    idp.setGraphFault({ mode: 'hang' });
    const hung = await fetch(`${idp.graphBaseUrl}/v1.0/users/${idp.user('alice').oid}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(200),
    }).catch((error: unknown) => error);
    expect((hung as Error).name).toBe('TimeoutError');
    idp.setGraphFault({ mode: 'none' });
    expect(idp.state.graphFault).toEqual({ mode: 'none' });
  });
});

describe('test-control API [SEC-F002-13 e]', () => {
  it('listens on 127.0.0.1 only', () => {
    expect(new URL(idp.control.url).hostname).toBe('127.0.0.1');
  });

  it('refuses a request without the per-run bearer, or with another one', async () => {
    const none = await fetch(`${idp.control.url}/users`);
    expect(none.status).toBe(401);
    expect(
      (await control('GET', '/users', undefined, randomBytes(32).toString('base64url'))).status,
    ).toBe(401);
    expect((await control('GET', '/users', undefined, `${idp.control.token}x`)).status).toBe(401);
    expect(idp.control.token.length).toBeGreaterThanOrEqual(43);
  });

  it('lists users without secrets, and disables and re-enables one', async () => {
    const list = await control('GET', '/users');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(idp.clientSecret);
    expect((await control('PATCH', '/users/alice', { enabled: false })).status).toBe(200);
    expect((await graph('GET', `/v1.0/users/${idp.user('alice').oid}`)).body.accountEnabled).toBe(
      false,
    );
    expect((await control('PATCH', '/users/alice', { enabled: true })).status).toBe(200);
  });

  it('changes a user’s groups, which the next token carries', async () => {
    const other = idp.user('mallory').groups;
    await control('PATCH', '/users/alice', { groups: [idp.adminGroupId] });
    const claims = await verify(idp.mintAccessToken('alice'), idp.rtsClientId);
    expect(claims.groups).toEqual([idp.adminGroupId]);
    await control('PATCH', '/users/alice', { groups: [idp.accessGroupId] });
    expect(idp.user('mallory').groups).toEqual(other);
  });

  it('deletes a user in Graph', async () => {
    await control('PATCH', '/users/bob', { deletedInGraph: true });
    expect((await graph('GET', `/v1.0/users/${idp.user('bob').oid}`)).status).toBe(404);
    await control('PATCH', '/users/bob', { deletedInGraph: false });
  });

  it('mints Entra-shaped tokens, including deliberately bad ones', async () => {
    const minted = await control('POST', '/tokens', { username: 'alice', claims: { ver: '1.0' } });
    expect(minted.status).toBe(201);
    const claims = await verify(String(minted.body.access_token), idp.rtsClientId);
    expect(claims.ver).toBe('1.0');
    const foreign = await control('POST', '/tokens', { username: 'alice', signWith: 'foreign' });
    await expect(verify(String(foreign.body.access_token), idp.rtsClientId)).rejects.toThrow();
  });

  it('validates bodies and names', async () => {
    expect((await control('PATCH', '/users/alice', { password: 'x' })).status).toBe(400);
    expect((await control('PATCH', '/users/nobody', { enabled: false })).status).toBe(404);
    expect((await control('PUT', '/graph-fault', { mode: 'error' })).status).toBe(400);
    expect((await control('POST', '/tokens', { username: 'nobody' })).status).toBe(404);
    expect((await control('GET', '/nothing')).status).toBe(404);
  });
});

describe('no password field anywhere in the mock', () => {
  it('has no password input in its sources', () => {
    const dir = join(import.meta.dirname, '../src/mock-idp');
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/type=\\?["']password/i);
      expect(source, file).not.toMatch(/name=\\?["']pass(word|wd)?\b/i);
    }
  });
});
