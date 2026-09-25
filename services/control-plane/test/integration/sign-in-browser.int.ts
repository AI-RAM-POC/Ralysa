// F-002-T10 (part 2) against the dev stack and the in-process mock IdP: flow B, `/login
// --browser`, loopback + PKCE through RTS. The CLI's side uses @ralysa/auth's PKCE, state,
// authorize-URL and callback helpers (T11); the browser is the mock's headless driver; RTS is
// reached with inject so each leg can come from the IP a test needs.
//   - TC-F-002-01: flow B end to end; /v1/me; a group change stored and audited at the next
//     sign-in; `auth.sign_in success` written at redemption, not at the callback.
//   - TC-F-002-30: the browser-binding cookie (missing, wrong), the redemption IP (deny, alert),
//     an unredeemed code (cleanup), a second redemption (reuse), one event per attempt.
//   - TC-F-002-07 (flow-B part), -08 (flow B), -31 (admin on flow B), the RFC 6749 §4.1.2.1
//     plain-text error and the IdP's own refusal.
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  readAuthorizationCallback,
} from '@ralysa/auth';
import { CLI_CLIENT_ID } from '@ralysa/protocol/auth';
import { uuidv7 } from '@ralysa/protocol/common';
import { AuthConfig } from '@ralysa/protocol/control-plane';
import { createInMemoryKeyCustody, createInMemorySecretStore } from '@ralysa/secrets';
import { devStackOrSkip } from '@ralysa/dev-stack/harness';
import { type MockIdp, signInAtAuthorize, startMockIdp } from '@ralysa/dev-stack/mock-idp';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createRejectionAggregator } from '../../src/audit/rejections.js';
import { type AuditWriter, createAuditWriter } from '../../src/audit/writer.js';
import { runCleanup } from '../../src/auth/cleanup.js';
import { BINDING_COOKIE_DEV } from '../../src/auth/flow-b.js';
import { createGraphDirectory } from '../../src/auth/idp/graph-directory.js';
import { createIdpMetadataSource } from '../../src/auth/idp/metadata.js';
import { idpCallbackUrl } from '../../src/auth/idp/oidc-client.js';
import { policyVersion } from '../../src/auth/policy-version.js';
import { INVALID_AUTHORIZE_TEXT } from '../../src/auth/routes/authorize.js';
import type { ServeConfig } from '../../src/config/schema.js';
import { createDb } from '../../src/db/kysely.js';
import type { Database } from '../../src/db/types.js';
import { createRateLimiter } from '../../src/http/rate-limits.js';
import { ensureOrganization } from '../../src/org/bootstrap.js';
import { fakeKeys } from '../fixtures/fake-keys.js';
import { serveConfig, serveConfigInput } from '../fixtures/serve-config.js';
import { type TestDatabase, createTestDatabase } from './support/db.js';

const stack = await devStackOrSkip();
const kv = (key: string) => `kv/ralysa/control-plane/${key}`;
const BASE = 'http://127.0.0.1:4199';
const LOOPBACK = 'http://127.0.0.1:49152/callback';

interface StoredEvent {
  action: string;
  outcome: string;
  reason_code: string | null;
  actor_user_id: string | null;
  actor_idp_subject: string | null;
  session_id: string | null;
  policy_version: string | null;
  details: Record<string, unknown>;
}

describe.skipIf(stack === undefined)('IdP sign-in, flow B (F-002-T10)', () => {
  let idp: MockIdp;
  let config: ServeConfig;
  let db: TestDatabase | undefined;
  let cpDb: Kysely<Database>;
  let writer: AuditWriter;
  let app: FastifyInstance;
  let alertApp: FastifyInstance;
  let cfg: AuthConfig;
  const t = (): TestDatabase => {
    if (db === undefined) throw new Error('beforeAll did not create the database');
    return db;
  };

  const events = async (where: { action?: string; subject?: string; since?: Date } = {}) =>
    (
      await t().superuser.query<StoredEvent>(
        `SELECT action, outcome, reason_code, actor_user_id, actor_idp_subject, session_id,
                policy_version, details
           FROM audit.audit_event
          WHERE ($1::text IS NULL OR action = $1) AND ($2::text IS NULL OR actor_idp_subject = $2)
            AND ($3::timestamptz IS NULL OR ts >= $3)
          ORDER BY ingest_seq`,
        [where.action ?? null, where.subject ?? null, where.since ?? null],
      )
    ).rows;
  const signIns = (subject?: string, since?: Date) =>
    events({
      action: 'auth.sign_in',
      ...(subject === undefined ? {} : { subject }),
      ...(since === undefined ? {} : { since }),
    });
  const dbNow = async () =>
    (await t().superuser.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]?.now ??
    new Date();
  const sessionsOf = async (oid: string) =>
    (
      await t().superuser.query<{ id: string; status: string; roles: string[]; flow: string }>(
        `SELECT s.id, s.status, s.roles, s.flow FROM cp.auth_session s
           JOIN cp.app_user u ON u.id = s.user_id WHERE u.idp_subject = $1 ORDER BY s.created_at`,
        [oid],
      )
    ).rows;

  interface Leg {
    status: number;
    location?: string;
    cookie?: string;
    body: string;
  }
  const leg = async (
    target: FastifyInstance,
    url: string,
    options: { ip?: string; cookie?: string } = {},
  ): Promise<Leg> => {
    const reply = await target.inject({
      method: 'GET',
      url,
      remoteAddress: options.ip ?? '127.0.0.1',
      headers: {
        'user-agent': 'Mozilla/5.0 (test browser)',
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      },
    });
    const setCookie = reply.headers['set-cookie'];
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    return {
      status: reply.statusCode,
      ...(typeof reply.headers.location === 'string' ? { location: reply.headers.location } : {}),
      ...(first === undefined ? {} : { cookie: first.split(';')[0] ?? '' }),
      body: reply.body,
    };
  };

  /** The CLI starts flow B, the browser signs in; returns what reached the loopback. */
  const browserSignIn = async (
    username: string,
    options: {
      target?: FastifyInstance;
      cookie?: (real: string) => string | undefined;
      ip?: string;
    } = {},
  ) => {
    const target = options.target ?? app;
    const { verifier, challenge } = await createPkcePair();
    const state = createState();
    const authorizeUrl = new URL(
      buildAuthorizeUrl(cfg, { redirectUri: LOOPBACK, challenge, state }).href,
    );
    const start = await leg(target, `${authorizeUrl.pathname}${authorizeUrl.search}`);
    expect(start.status).toBe(302);
    expect(start.cookie?.startsWith(`${BINDING_COOKIE_DEV}=`)).toBe(true);
    const atIdp = await signInAtAuthorize({ authorizationUrl: start.location ?? '', username });
    expect(atIdp.origin + atIdp.pathname).toBe(idpCallbackUrl(config));
    const cookie = options.cookie === undefined ? start.cookie : options.cookie(start.cookie ?? '');
    const callback = await leg(target, `${atIdp.pathname}${atIdp.search}`, {
      ...(cookie === undefined ? {} : { cookie }),
      ...(options.ip === undefined ? {} : { ip: options.ip }),
    });
    const loopback = callback.location === undefined ? undefined : new URL(callback.location);
    return { verifier, state, callback, loopback };
  };

  const redeem = (
    code: string,
    verifier: string,
    options: { target?: FastifyInstance; ip?: string; redirectUri?: string } = {},
  ) =>
    (options.target ?? app).inject({
      method: 'POST',
      url: '/oauth2/token',
      remoteAddress: options.ip ?? '127.0.0.1',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'ralysa-cli/test',
      },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLI_CLIENT_ID,
        code,
        redirect_uri: options.redirectUri ?? LOOPBACK,
        code_verifier: verifier,
      }).toString(),
    });

  /** Flow B end to end for `username`: the RTS tokens. */
  const signIn = async (username: string) => {
    const { verifier, state, loopback } = await browserSignIn(username);
    const code = readAuthorizationCallback(Object.fromEntries(loopback?.searchParams ?? []), state);
    const reply = await redeem(code, verifier);
    expect(reply.statusCode, reply.body).toBe(200);
    return reply.json<{ access_token: string; refresh_token: string }>();
  };
  const me = (accessToken: string) =>
    app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${accessToken}` } });

  const buildWith = async (serve: ServeConfig) => {
    const secrets = createInMemorySecretStore({
      [kv('idp-client-secret')]: idp.clientSecret,
      [kv('audit-hmac')]: 'test-audit-hmac-key-not-a-secret',
    });
    const idpMetadata = createIdpMetadataSource({ issuer: idp.issuer });
    return buildApp({
      config: serve,
      keys: (await fakeKeys()).keys,
      rts: {
        db: cpDb,
        custody: createInMemoryKeyCustody(),
        directory: createGraphDirectory({
          config: serve,
          secrets,
          tokenEndpoint: async () => (await idpMetadata.get()).tokenEndpoint,
        }),
        writer,
        rejections: createRejectionAggregator({ emit: () => undefined }),
        secrets,
        idpMetadata,
      },
      rateLimiter: createRateLimiter({ perIpPerMinute: 10_000, globalPerMinute: 10_000 }),
      pingDatabase: () => Promise.resolve(true),
    });
  };

  beforeAll(async () => {
    idp = await startMockIdp({ rtsRedirectUris: [`${BASE}/oauth2/idp/callback`] });
    const input = serveConfigInput({
      env: 'test',
      org: {
        id: uuidv7(),
        name: 'Org B',
        residency: 'in_country',
        region: 'qa-doha',
        deployment_model: 'on_prem',
      },
      public_base_url: BASE,
      idp: {
        kind: 'entra',
        tenant_id: idp.tenantId,
        issuer: idp.issuer,
        rts_client_id: idp.rtsClientId,
        allowed_public_client_ids: [idp.cliClientId],
        signin_scope: idp.signinScope,
        client_secret_path: kv('idp-client-secret'),
        graph_base_url: idp.graphBaseUrl,
        require_mfa_claim: true,
      },
      access: { access_group_id: idp.accessGroupId, admin_group_id: idp.adminGroupId },
    });
    config = serveConfig(input);
    db = await createTestDatabase(stack!);
    await db.migrate(config.org.id);
    cpDb = createDb<Database>(await db.pool('cp_app', 6));
    await ensureOrganization(cpDb, config);
    writer = createAuditWriter({ db: createDb<Database>(await db.pool('audit_writer', 3)) });
    app = await buildWith(config);
    alertApp = await buildWith(
      serveConfig({
        ...input,
        access: { ...(input.access as object), loopback_ip_mismatch: 'alert' },
      }),
    );
    cfg = AuthConfig.parse((await app.inject({ url: '/v1/auth/config' })).json());
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await alertApp.close();
    await idp.close();
    await db?.drop();
  });

  // --- TC-F-002-01 -----------------------------------------------------------------------------
  it('TC-F-002-01: flow B end to end; success is written at redemption; /v1/me; a group change', async () => {
    const alice = idp.user('alice');
    const since = await dbNow();
    const { verifier, state, loopback } = await browserSignIn('alice');
    expect(`${loopback?.origin ?? ''}${loopback?.pathname ?? ''}`).toBe(LOOPBACK);
    // The callback created a pending session and wrote no sign-in event yet (D-38).
    expect(await signIns(alice.oid, since)).toHaveLength(0);
    expect((await sessionsOf(alice.oid)).at(-1)).toMatchObject({
      status: 'pending',
      flow: 'loopback_pkce',
    });

    const code = readAuthorizationCallback(Object.fromEntries(loopback?.searchParams ?? []), state);
    expect(code).toMatch(/^rly_ac_/);
    const reply = await redeem(code, verifier);
    expect(reply.statusCode, reply.body).toBe(200);
    const tokens = reply.json<{ access_token: string; refresh_token: string }>();
    expect((await sessionsOf(alice.oid)).at(-1)).toMatchObject({
      status: 'active',
      roles: ['user'],
    });

    const view = await me(tokens.access_token);
    expect(view.json()).toMatchObject({
      idp_subject: alice.oid,
      org_id: config.org.id,
      email: alice.upn,
      display_name: alice.displayName,
      groups: [{ idp_group_id: idp.accessGroupId, role: 'access' }],
    });
    const recorded = await signIns(alice.oid, since);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      outcome: 'success',
      policy_version: policyVersion(config.access),
      details: {
        flow: 'loopback_pkce',
        client_ip: '127.0.0.1',
        callback_ip: '127.0.0.1',
        ip_mismatch: false,
        roles: ['user'],
        amr: ['pwd', 'mfa'],
        browser_user_agent: 'Mozilla/5.0 (test browser)',
        user_agent: 'ralysa-cli/test',
      },
    });

    // The mock moves alice to another group as well: stored membership follows the claims.
    const extra = uuidv7();
    idp.patchUser('alice', { groups: [idp.accessGroupId, extra] });
    try {
      const again = await signIn('alice');
      const groups = (await me(again.access_token)).json<{ groups: { idp_group_id: string }[] }>()
        .groups;
      expect(groups.map((g) => g.idp_group_id).sort()).toEqual([idp.accessGroupId, extra].sort());
      expect(
        (await events({ action: 'directory.group_membership.changed', subject: alice.oid })).at(-1)
          ?.details,
      ).toMatchObject({
        added: [extra],
        removed: [],
        privileged: false,
      });
    } finally {
      idp.patchUser('alice', { groups: [idp.accessGroupId] });
    }
  });

  // --- TC-F-002-08 (flow B) --------------------------------------------------------------------
  it('TC-F-002-08: bob is refused through the loopback redirect; no user, no session', async () => {
    const bob = idp.user('bob');
    const { state, loopback } = await browserSignIn('bob');
    expect(loopback?.searchParams.get('error')).toBe('access_denied');
    expect(loopback?.searchParams.get('error_description')).toBe('not_in_access_group');
    expect(() =>
      readAuthorizationCallback(Object.fromEntries(loopback?.searchParams ?? []), state),
    ).toThrow(expect.objectContaining({ i18nKey: 'auth.denied.not_in_access_group' }));
    expect(await sessionsOf(bob.oid)).toEqual([]);
    expect(
      (await t().superuser.query('SELECT 1 FROM cp.app_user WHERE idp_subject = $1', [bob.oid]))
        .rowCount,
    ).toBe(0);
    expect((await signIns(bob.oid)).at(-1)).toMatchObject({
      outcome: 'denied',
      reason_code: 'not_in_access_group',
      details: { flow: 'loopback_pkce' },
    });
  });

  it('the IdP refusing the user (carol, disabled) is failure idp_error, redirected to the loopback', async () => {
    const since = await dbNow();
    const { loopback } = await browserSignIn('carol');
    expect(loopback?.searchParams.get('error')).toBe('access_denied');
    expect(loopback?.searchParams.get('error_description')).toBe('idp_error');
    const recorded = await signIns(undefined, since);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ outcome: 'failure', reason_code: 'idp_error' });
  });

  // --- TC-F-002-30 -----------------------------------------------------------------------------
  it('TC-F-002-30: a missing or wrong browser-binding cookie is browser_binding_failed, not redirected', async () => {
    const since = await dbNow();
    const missing = await browserSignIn('alice', { cookie: () => undefined });
    expect(missing.callback.status).toBe(400);
    expect(missing.loopback).toBeUndefined();
    const wrong = await browserSignIn('alice', { cookie: () => `${BINDING_COOKIE_DEV}=attacker` });
    expect(wrong.callback.status).toBe(400);
    const recorded = await signIns(undefined, since);
    expect(recorded.map((e) => [e.outcome, e.reason_code, e.details.check])).toEqual([
      ['failure', 'browser_binding_failed', 'cookie_missing'],
      ['failure', 'browser_binding_failed', 'cookie_mismatch'],
    ]);
  });

  it('TC-F-002-30: redeemed from another IP → denied loopback_ip_mismatch, pending session revoked', async () => {
    const oid = idp.user('fatima').oid;
    const since = await dbNow();
    const { verifier, state, loopback } = await browserSignIn('fatima');
    const code = readAuthorizationCallback(Object.fromEntries(loopback?.searchParams ?? []), state);
    const reply = await redeem(code, verifier, { ip: '203.0.113.9' });
    expect(reply.statusCode).toBe(400);
    expect(reply.json()).toMatchObject({
      error: 'access_denied',
      ralysa_error: { code: 'loopback_ip_mismatch', i18n_key: 'auth.denied.loopback_ip_mismatch' },
    });
    expect((await sessionsOf(oid)).at(-1)?.status).toBe('revoked');
    const recorded = await signIns(oid, since);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      outcome: 'denied',
      reason_code: 'loopback_ip_mismatch',
      details: { ip_mismatch: true, callback_ip: '127.0.0.1', client_ip: '203.0.113.9' },
    });
    expect(
      (await events({ action: 'auth.session.revoked', subject: oid })).at(-1)?.details,
    ).toMatchObject({
      cause: 'loopback_ip_mismatch',
    });
  });

  it('TC-F-002-30: with loopback_ip_mismatch=alert the sign-in succeeds with ip_mismatch=true', async () => {
    const oid = idp.user('sam').oid;
    const since = await dbNow();
    const { verifier, state, loopback } = await browserSignIn('sam', { target: alertApp });
    const code = readAuthorizationCallback(Object.fromEntries(loopback?.searchParams ?? []), state);
    const reply = await redeem(code, verifier, { target: alertApp, ip: '203.0.113.9' });
    expect(reply.statusCode, reply.body).toBe(200);
    const recorded = await signIns(oid, since);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ outcome: 'success', details: { ip_mismatch: true } });
  });

  it('TC-F-002-30: a wrong verifier does not consume the code; a second redemption is reuse', async () => {
    const oid = idp.user('olga').oid;
    const since = await dbNow();
    const { verifier, state, loopback } = await browserSignIn('olga');
    const code = readAuthorizationCallback(Object.fromEntries(loopback?.searchParams ?? []), state);
    const wrong = await redeem(code, 'w'.repeat(43));
    expect(wrong.json()).toEqual({ error: 'invalid_grant' });
    const otherRedirect = await redeem(code, verifier, {
      redirectUri: 'http://127.0.0.1:1/callback',
    });
    expect(otherRedirect.json()).toEqual({ error: 'invalid_grant' });
    expect((await redeem(code, verifier)).statusCode).toBe(200);
    const second = await redeem(code, verifier);
    expect(second.json()).toEqual({ error: 'invalid_grant' });
    expect((await sessionsOf(oid)).at(-1)?.status).toBe('revoked');
    expect(
      (await events({ action: 'auth.token.reuse_detected', subject: oid })).at(-1)?.details,
    ).toMatchObject({
      token_kind: 'authorization_code',
    });
    // Exactly one sign-in event for the attempt.
    expect(await signIns(oid, since)).toHaveLength(1);
  });

  it('TC-F-002-30: an unredeemed code is recorded by cleanup as code_not_redeemed, once', async () => {
    const oid = idp.user('sam').oid;
    const since = await dbNow();
    const { loopback } = await browserSignIn('sam');
    expect(loopback?.searchParams.get('code')).toMatch(/^rly_ac_/);
    await t().superuser.query(
      `UPDATE cp.authorization_code SET expires_at = clock_timestamp() - interval '1 second'
        WHERE used_at IS NULL AND session_id IN
          (SELECT s.id FROM cp.auth_session s JOIN cp.app_user u ON u.id = s.user_id
            WHERE u.idp_subject = $1 AND s.status = 'pending')`,
      [oid],
    );
    const deps = {
      db: cpDb,
      orgId: config.org.id,
      writer,
      policyVersion: policyVersion(config.access),
    };
    await runCleanup(deps);
    await runCleanup(deps);
    const recorded = await signIns(oid, since);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ outcome: 'failure', reason_code: 'code_not_redeemed' });
    expect((await sessionsOf(oid)).at(-1)?.status).toBe('revoked');
  });

  // --- TC-F-002-31 (flow B) --------------------------------------------------------------------
  it('TC-F-002-31: admin rights on flow B (a strong flow), for admin-only and both-group users', async () => {
    idp.patchUser('erin', { amr: ['pwd', 'mfa'], acrs: null });
    try {
      const erin = await signIn('erin');
      expect((await me(erin.access_token)).json()).toMatchObject({
        roles: ['user', 'platform_admin'],
      });
    } finally {
      idp.patchUser('erin', { amr: ['fido'], acrs: ['c1'] });
    }
    const dana = await signIn('dana');
    expect((await me(dana.access_token)).json()).toMatchObject({ roles: ['platform_admin'] });
  });

  // --- TC-F-002-07 (flow B) --------------------------------------------------------------------
  it('TC-F-002-07 (flow B): 10 sign-ins → exactly 10 success events, no tokens or codes stored', async () => {
    const since = await dbNow();
    for (let i = 0; i < 10; i++) await signIn(i % 2 === 0 ? 'alice' : 'fatima');
    const recorded = await signIns(undefined, since);
    expect(recorded.map((e) => [e.outcome, e.reason_code])).toEqual(
      Array.from({ length: 10 }, () => ['success', null]),
    );
    const everything = JSON.stringify(await events());
    expect(everything).not.toMatch(/eyJ[A-Za-z0-9_-]+\.eyJ/);
    expect(everything).not.toMatch(/rly_(rt|ac)_/);
    expect(everything).not.toContain(idp.clientSecret);
    const stored = JSON.stringify(
      (await t().superuser.query('SELECT sign_in FROM cp.authorization_code')).rows,
    );
    expect(stored).not.toMatch(/eyJ|rly_/);
  });

  // --- RFC 6749 §4.1.2.1 -----------------------------------------------------------------------
  it('an invalid client or redirect URI gets the plain-text en/ar error; other errors go to the loopback', async () => {
    const { challenge } = await createPkcePair();
    const good = new URL(
      buildAuthorizeUrl(cfg, { redirectUri: LOOPBACK, challenge, state: createState() }).href,
    );
    for (const [name, value] of [
      ['client_id', 'someone-else'],
      ['redirect_uri', 'http://evil.example/callback'],
      ['redirect_uri', 'http://localhost:49152/callback'],
    ] as const) {
      const url = new URL(good.href);
      url.searchParams.set(name, value);
      const reply = await app.inject({ url: `${url.pathname}${url.search}` });
      expect(reply.statusCode).toBe(400);
      expect(reply.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(reply.headers['content-language']).toBe('en, ar');
      expect(reply.headers.location).toBeUndefined();
      expect(reply.body).toBe(INVALID_AUTHORIZE_TEXT);
      expect(reply.body).toMatch(/[؀-ۿ]/);
    }
    const noChallenge = new URL(good.href);
    noChallenge.searchParams.delete('code_challenge');
    const reply = await app.inject({ url: `${noChallenge.pathname}${noChallenge.search}` });
    expect(reply.statusCode).toBe(302);
    const location = new URL(reply.headers.location as string);
    expect(location.origin + location.pathname).toBe(LOOPBACK);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    // An unknown or replayed callback state is not redirectable either.
    const unknown = await app.inject({ url: '/oauth2/idp/callback?state=nope&code=x' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toBe(INVALID_AUTHORIZE_TEXT);
  });
});
