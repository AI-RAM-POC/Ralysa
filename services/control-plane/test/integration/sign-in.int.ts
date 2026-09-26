// F-002-T10 (part 1) against the dev stack and the in-process mock IdP (T09): flow A sign-in, the
// Entra token validator, Microsoft Graph, identity mapping and the audit trail, over real
// Postgres. The mock's Graph stub is called through the real Graph directory, with the RTS client
// secret from a secret store; RTS signs with the in-memory custody (as in the T08 tests).
//   - TC-F-002-02: the IdP-native device flow through @ralysa/auth (T11) and the exchange grant,
//     end to end over HTTP; then /v1/me and a refresh (Graph re-check).
//   - TC-F-002-03: expired device code (client-reported), a reused device code, replay, failure
//     then retry, and the refused token shapes.
//   - TC-F-002-04: the device-code switch: config, the grant, revocation of flow-A sessions.
//   - TC-F-002-07 (flow A and client-reported parts): scripted attempts → exactly one
//     auth.sign_in each; no token, code or secret in stored events; throttled reports write none.
//   - TC-F-002-08 (flow A), -09, -21, -24, -31.
import { createServer } from 'node:net';
import { exchangeIdpToken, fetchAuthConfig, startIdpDeviceSignIn } from '@ralysa/auth';
import { CLI_CLIENT_ID } from '@ralysa/protocol/auth';
import { uuidv7 } from '@ralysa/protocol/common';
import { createInMemoryKeyCustody, createInMemorySecretStore } from '@ralysa/secrets';
import { devStackOrSkip } from '@ralysa/dev-stack/harness';
import {
  ACCESS_GROUP_NAME,
  FATIMA_NAME,
  type MockIdp,
  approveDeviceCode,
  startMockIdp,
} from '@ralysa/dev-stack/mock-idp';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createRejectionAggregator } from '../../src/audit/rejections.js';
import { createAuditWriter } from '../../src/audit/writer.js';
import { revokeDeviceCodeSessions } from '../../src/auth/device-code-switch.js';
import { type GraphDirectory, createGraphDirectory } from '../../src/auth/idp/graph-directory.js';
import { createIdpMetadataSource } from '../../src/auth/idp/metadata.js';
import { policyVersion } from '../../src/auth/policy-version.js';
import { REPORTS_PER_CLIENT_PER_MINUTE } from '../../src/auth/routes/sign-in-failures.js';
import { ServeConfig } from '../../src/config/schema.js';
import { createDb } from '../../src/db/kysely.js';
import type { Database } from '../../src/db/types.js';
import { mintAccessToken } from '../../src/auth/tokens/mint.js';
import { createRateLimiter } from '../../src/http/rate-limits.js';
import { type MemoryMetrics, createMemoryMetrics } from '../../src/observability/metrics.js';
import { ensureOrganization } from '../../src/org/bootstrap.js';
import { fakeKeys } from '../fixtures/fake-keys.js';
import { serveConfig, serveConfigInput } from '../fixtures/serve-config.js';
import { type TestDatabase, createTestDatabase } from './support/db.js';

const stack = await devStackOrSkip();
const kv = (key: string) => `kv/ralysa/control-plane/${key}`;
const HMAC_KEY = 'test-audit-hmac-key-not-a-secret';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

interface StoredEvent {
  event_id: string;
  action: string;
  outcome: string;
  reason_code: string | null;
  actor_user_id: string | null;
  actor_idp_subject: string | null;
  session_id: string | null;
  trace_id: string;
  policy_version: string | null;
  attestation: string;
  ts: Date;
  details: Record<string, unknown>;
}

describe.skipIf(stack === undefined)('IdP sign-in, flow A (F-002-T10)', () => {
  let idp: MockIdp;
  let config: ServeConfig;
  let db: TestDatabase | undefined;
  let cpDb: Kysely<Database>;
  let app: FastifyInstance;
  let base: string;
  let directory: GraphDirectory;
  let metrics: MemoryMetrics;
  let signingKeys: Awaited<ReturnType<typeof fakeKeys>>['keys'];
  const graphClock = { offset: 0 };
  const t = (): TestDatabase => {
    if (db === undefined) throw new Error('beforeAll did not create the database');
    return db;
  };

  // --- helpers -------------------------------------------------------------------------------
  const form = (target: FastifyInstance, params: Record<string, string>, ip = '127.0.0.1') =>
    target.inject({
      method: 'POST',
      url: '/oauth2/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'ralysa-cli/test',
      },
      payload: new URLSearchParams(params).toString(),
      remoteAddress: ip,
    });
  const exchange = (
    subjectToken: string,
    extra: Record<string, string> = {},
    target: FastifyInstance = app,
    ip?: string,
  ) =>
    form(
      target,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        client_id: CLI_CLIENT_ID,
        subject_token: subjectToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        ...extra,
      },
      ip,
    );
  const refresh = (token: string) =>
    form(app, { grant_type: 'refresh_token', client_id: CLI_CLIENT_ID, refresh_token: token });
  const me = (accessToken: string) =>
    app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${accessToken}` } });
  /** GET /v1/internal/principals/{user}?sid= with the PEP's service token (#47). */
  const principalFor = async (accessToken: string) => {
    const { sub, sid } = decodeJwt(accessToken);
    const now = Math.floor(Date.now() / 1000);
    const service = await mintAccessToken(signingKeys, {
      iss: base,
      aud: 'control-plane',
      sub: 'svc:si-gateway',
      client_id: 'svc:si-gateway',
      tid: config.org.id,
      token_use: 'service',
      iat: now,
      nbf: now,
      exp: now + 300,
      jti: uuidv7(),
    });
    const reply = await app.inject({
      url: `/v1/internal/principals/${String(sub)}?sid=${String(sid)}`,
      headers: { authorization: `Bearer ${service}` },
    });
    expect(reply.statusCode, reply.body).toBe(200);
    return reply.json<{ roles: string[]; session_id: string; session_roles: string[] }>();
  };

  const events = async (where: { action?: string; subject?: string; since?: Date } = {}) =>
    (
      await t().superuser.query<StoredEvent>(
        `SELECT event_id, action, outcome, reason_code, actor_user_id, actor_idp_subject, session_id,
                trace_id, policy_version, attestation, ts, details
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

  const userRow = async (oid: string) =>
    (
      await t().superuser.query<{ id: string; status: string; revoked_before: Date | null }>(
        'SELECT id, status, revoked_before FROM cp.app_user WHERE idp_subject = $1',
        [oid],
      )
    ).rows[0];
  const sessionsOf = async (oid: string) =>
    (
      await t().superuser.query<{
        id: string;
        status: string;
        roles: string[];
        flow: string;
        device_label: string | null;
      }>(
        `SELECT s.id, s.status, s.roles, s.flow, s.device_label FROM cp.auth_session s
           JOIN cp.app_user u ON u.id = s.user_id WHERE u.idp_subject = $1 ORDER BY s.created_at`,
        [oid],
      )
    ).rows;

  const signInAs = async (username: string, extra: Record<string, string> = {}) => {
    const reply = await exchange(idp.mintAccessToken(username), extra);
    expect(reply.statusCode, reply.body).toBe(200);
    return reply.json<{ access_token: string; refresh_token: string; issued_token_type: string }>();
  };

  // --- setup ---------------------------------------------------------------------------------
  beforeAll(async () => {
    idp = await startMockIdp({ deviceCodeTtlSeconds: 3, deviceCodeIntervalSeconds: 1 });
    const port = await freePort();
    base = `http://127.0.0.1:${String(port)}`;
    const input = serveConfigInput({
      env: 'test',
      org: {
        id: uuidv7(),
        name: 'Org SI',
        residency: 'in_country',
        region: 'qa-doha',
        deployment_model: 'on_prem',
      },
      public_base_url: base,
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
      // A PEP that resolves principals (#47).
      services: [
        {
          name: 'si-gateway',
          client_id: 'svc:si-gateway',
          transit_key: 'ralysa-svc-si-gateway',
          audit_actions: ['model.call.completed'],
        },
      ],
    });
    config = serveConfig(input);
    const secrets = createInMemorySecretStore({
      [kv('idp-client-secret')]: idp.clientSecret,
      [kv('audit-hmac')]: HMAC_KEY,
    });
    const idpMetadata = createIdpMetadataSource({ issuer: idp.issuer });
    directory = createGraphDirectory({
      config,
      secrets,
      tokenEndpoint: async () => (await idpMetadata.get()).tokenEndpoint,
      now: () => Date.now() + graphClock.offset,
    });
    db = await createTestDatabase(stack!);
    await db.migrate(config.org.id);
    cpDb = createDb<Database>(await db.pool('cp_app', 6));
    await ensureOrganization(cpDb, config);
    const writer = createAuditWriter({
      db: createDb<Database>(await db.pool('audit_writer', 3)),
    });
    metrics = createMemoryMetrics();
    signingKeys = (await fakeKeys()).keys;
    const rts = {
      db: cpDb,
      custody: createInMemoryKeyCustody(),
      directory,
      writer,
      rejections: createRejectionAggregator({ emit: () => undefined }),
      secrets,
      idpMetadata,
      metrics,
    };
    app = await buildApp({
      config,
      keys: signingKeys,
      rts,
      rateLimiter: createRateLimiter({ perIpPerMinute: 10_000, globalPerMinute: 10_000 }),
      pingDatabase: () => Promise.resolve(true),
    });
    await app.listen({ host: '127.0.0.1', port });
  }, 60_000);

  afterEach(() => {
    idp.setGraphFault({ mode: 'none' });
  });

  afterAll(async () => {
    await app.close();
    await idp.close();
    await db?.drop();
  });

  // --- TC-F-002-02 -----------------------------------------------------------------------------
  it('TC-F-002-02: device flow through @ralysa/auth, then the exchange, /v1/me and a refresh', async () => {
    const cfg = await fetchAuthConfig(base);
    expect(cfg.flows.idp_device).toBe(true);
    expect(cfg.idp.device_authorization_endpoint).toBe(idp.endpoints.deviceAuthorization);
    const signIn = await startIdpDeviceSignIn(cfg);
    expect(signIn.userCode).toMatch(/\S+/);
    expect(signIn.verificationUri).toContain(idp.tenantId);
    expect(signIn.intervalSeconds).toBe(1);
    const polled = signIn.poll();
    await approveDeviceCode({
      verificationUri: signIn.verificationUri,
      userCode: signIn.userCode,
      username: 'alice',
    });
    const { idpAccessToken } = await polled;
    const tokens = await exchangeIdpToken(cfg, idpAccessToken, { deviceLabel: 'alice-laptop' });
    const claims = decodeJwt(tokens.accessToken);
    const alice = idp.user('alice');
    expect(claims).toMatchObject({
      aud: 'control-plane',
      idp_sub: alice.oid,
      tid: config.org.id,
      surface: 'cli',
    });

    const view = await me(tokens.accessToken);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      idp_subject: alice.oid,
      org_id: config.org.id,
      email: alice.upn,
      display_name: alice.displayName,
      roles: ['user'],
      groups: [
        { idp_group_id: idp.accessGroupId, role: 'access', display_name: ACCESS_GROUP_NAME },
      ],
    });
    const sessions = await sessionsOf(alice.oid);
    expect(sessions.at(-1)).toMatchObject({
      status: 'active',
      flow: 'idp_device',
      device_label: 'alice-laptop',
    });

    const refreshed = await refresh(tokens.refreshToken);
    expect(refreshed.statusCode, refreshed.body).toBe(200);

    const [signInEvent] = (await signIns(alice.oid)).slice(-1);
    expect(signInEvent).toMatchObject({
      outcome: 'success',
      reason_code: null,
      policy_version: policyVersion(config.access),
      attestation: 'server',
      session_id: sessions.at(-1)?.id,
      details: {
        flow: 'idp_device',
        protocol: 'oidc',
        client_type: 'public',
        client_ip: '127.0.0.1',
        reported_by: 'server',
        device_label: 'alice-laptop',
        roles: ['user'],
        amr: ['pwd', 'mfa'],
        idp_ipaddr: '127.0.0.1',
        ip_mismatch: false,
      },
    });
    expect(await events({ action: 'directory.user.provisioned', subject: alice.oid })).toHaveLength(
      1,
    );
  });

  // --- TC-F-002-03 -----------------------------------------------------------------------------
  it('TC-F-002-03: an expired device code is reported by the client as failure expired', async () => {
    const since = await dbNow();
    const cfg = await fetchAuthConfig(base);
    const signIn = await startIdpDeviceSignIn(cfg);
    await expect(signIn.poll()).rejects.toMatchObject({ name: 'DeviceCodeExpiredError' });
    // The report's event is written after the 202 (asynchronously, like every aggregated event).
    await expect.poll(async () => (await signIns(undefined, since)).length).toBe(1);
    const reported = (await signIns(undefined, since)).filter(
      (e) => (e.details.server as Record<string, unknown> | undefined)?.reported_by === 'client',
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      outcome: 'failure',
      reason_code: 'expired',
      attestation: 'client',
      policy_version: policyVersion(config.access),
    });
  }, 20_000);

  it('TC-F-002-03: a used device code is refused by the IdP; the same IdP token twice is replay', async () => {
    const start = (await (
      await fetch(idp.endpoints.deviceAuthorization, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: idp.cliClientId,
          scope: idp.signinScope,
        }).toString(),
      })
    ).json()) as Record<string, string>;
    await approveDeviceCode({
      verificationUri: String(start.verification_uri),
      userCode: String(start.user_code),
      username: 'alice',
    });
    const poll = () =>
      fetch(idp.endpoints.token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: idp.cliClientId,
          device_code: String(start.device_code),
        }).toString(),
      });
    const first = await poll();
    expect(first.status).toBe(200);
    const token = ((await first.json()) as { access_token: string }).access_token;
    const reused = await poll();
    expect(reused.status).toBe(400);
    expect(((await reused.json()) as { error: string }).error).toBe('invalid_grant');

    expect((await exchange(token)).statusCode).toBe(200);
    const second = await exchange(token);
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({
      error: 'invalid_grant',
      ralysa_error: { code: 'replay', i18n_key: 'auth.failed.replay' },
    });
    const last = (await signIns(idp.user('alice').oid)).at(-1);
    expect(last).toMatchObject({ outcome: 'failure', reason_code: 'replay' });
  });

  it('TC-F-002-03: a first exchange that fails after the replay key (Graph fault) burns the token', async () => {
    const token = idp.mintAccessToken('alice');
    idp.setGraphFault({ mode: 'error', status: 503 });
    const failed = await exchange(token);
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({
      error: 'temporarily_unavailable',
      ralysa_error: { code: 'idp_unavailable' },
    });
    idp.setGraphFault({ mode: 'none' });
    const retry = await exchange(token);
    expect(retry.statusCode).toBe(400);
    expect(retry.json()).toMatchObject({ ralysa_error: { code: 'replay' } });
  });

  it('TC-F-002-03: missing uti, alg other than RS256, ver 1.0 and an RTS-issued token are refused', async () => {
    const since = await dbNow();
    const cases: [string, number, string][] = [];
    const noUti = await exchange(idp.mintAccessToken('alice', { claims: { uti: undefined } }));
    cases.push([
      'no uti',
      noUti.statusCode,
      noUti.json<{ ralysa_error: { code: string } }>().ralysa_error.code,
    ]);
    const hs = await exchange(idp.mintAccessToken('alice', { header: { alg: 'HS256' } }));
    cases.push([
      'HS256',
      hs.statusCode,
      hs.json<{ ralysa_error: { code: string } }>().ralysa_error.code,
    ]);
    const v1 = await exchange(idp.mintAccessToken('alice', { claims: { ver: '1.0' } }));
    cases.push([
      'ver 1.0',
      v1.statusCode,
      v1.json<{ ralysa_error: { code: string } }>().ralysa_error.code,
    ]);
    const rtsToken = (await signInAs('alice')).access_token;
    const rts = await exchange(rtsToken);
    cases.push([
      'RTS token',
      rts.statusCode,
      rts.json<{ ralysa_error: { code: string } }>().ralysa_error.code,
    ]);
    const foreign = await exchange(idp.mintAccessToken('alice', { signWith: 'foreign' }));
    cases.push([
      'foreign key',
      foreign.statusCode,
      foreign.json<{ ralysa_error: { code: string } }>().ralysa_error.code,
    ]);
    expect(cases).toEqual([
      ['no uti', 400, 'invalid_idp_token'],
      ['HS256', 400, 'invalid_idp_token'],
      ['ver 1.0', 400, 'invalid_idp_token'],
      ['RTS token', 400, 'untrusted_issuer'],
      ['foreign key', 400, 'invalid_idp_token'],
    ]);
    // The refused attempts carry the HMAC of the unverified name, never the name or the token.
    const refused = (await signIns(undefined, since)).filter((e) => e.outcome === 'failure');
    expect(refused).toHaveLength(5);
    for (const event of refused) {
      expect(event.details).toMatchObject({ identifier_verified: false });
      expect(JSON.stringify(event)).not.toContain('alice@contoso.example');
    }
    expect(refused[0]?.details.attempted_identifier_hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  // --- TC-F-002-04 -----------------------------------------------------------------------------
  it('TC-F-002-04: device code off → config says so, the grant is unauthorized_client, flow-A sessions are revoked', async () => {
    const live = await signInAs('fatima');
    const offConfig = serveConfig({
      ...serveConfigInput(),
      ...configInput(config),
      access: { ...(configInput(config).access as object), device_code_enabled: false },
    });
    const off = await buildApp({
      config: offConfig,
      keys: (await fakeKeys()).keys,
      rts: {
        db: cpDb,
        custody: createInMemoryKeyCustody(),
        directory,
        writer: createAuditWriter({ db: createDb<Database>(await t().pool('audit_writer', 2)) }),
        rejections: createRejectionAggregator({ emit: () => undefined }),
        secrets: createInMemorySecretStore({ [kv('audit-hmac')]: HMAC_KEY }),
      },
      rateLimiter: createRateLimiter({ perIpPerMinute: 10_000, globalPerMinute: 10_000 }),
      pingDatabase: () => Promise.resolve(true),
    });
    try {
      const cfg = await off.inject({ url: '/v1/auth/config' });
      expect(cfg.json()).toMatchObject({ flows: { idp_device: false, loopback_pkce: true } });
      const refused = await exchange(idp.mintAccessToken('alice'), {}, off);
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        error: 'unauthorized_client',
        ralysa_error: {
          code: 'device_code_disabled',
          i18n_key: 'auth.denied.device_code_disabled',
        },
      });
      expect((await signIns(idp.user('alice').oid)).at(-1)).toMatchObject({
        outcome: 'denied',
        reason_code: 'device_code_disabled',
      });

      // What serve does at start with the switch off (SEC-F002-32, D-30).
      const writer = createAuditWriter({
        db: createDb<Database>(await t().pool('audit_writer', 2)),
      });
      const revoked = await revokeDeviceCodeSessions({ db: cpDb, orgId: config.org.id, writer });
      expect(revoked).toBeGreaterThan(0);
      expect(await revokeDeviceCodeSessions({ db: cpDb, orgId: config.org.id, writer })).toBe(0);
      const fatimaSessions = await sessionsOf(idp.user('fatima').oid);
      expect(fatimaSessions.every((s) => s.status === 'revoked')).toBe(true);
      const revocations = await events({
        action: 'auth.session.revoked',
        subject: idp.user('fatima').oid,
      });
      expect(revocations.at(-1)?.details).toMatchObject({
        cause: 'device_code_disabled',
        revoked_by: 'system',
      });
      const after = await refresh(live.refresh_token);
      expect(after.statusCode).toBe(400);
      expect(after.json()).toMatchObject({ ralysa_error: { code: 'revoked' } });
    } finally {
      await off.close();
    }
  });

  // --- TC-F-002-07 -----------------------------------------------------------------------------
  it('TC-F-002-07 (flow A, client reports): every attempt yields exactly one auth.sign_in; no secrets stored', async () => {
    const since = await dbNow();
    const expected: [string, string | null][] = [];
    const tokens: string[] = [];
    for (let i = 0; i < 10; i++) {
      const token = idp.mintAccessToken(i % 2 === 0 ? 'alice' : 'fatima');
      tokens.push(token);
      expect((await exchange(token)).statusCode).toBe(200);
      expected.push(['success', null]);
    }
    for (let i = 0; i < 10; i++) {
      expect((await exchange(idp.mintAccessToken('bob'))).statusCode).toBe(400);
      expected.push(['denied', 'not_in_access_group']);
    }
    // carol is disabled at the IdP (fixture): Graph says accountEnabled=false.
    for (let i = 0; i < 5; i++) {
      expect((await exchange(idp.mintAccessToken('carol'))).statusCode).toBe(400);
      expected.push(['denied', 'user_disabled']);
    }
    for (let i = 0; i < 5; i++) {
      const reply = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in-failures',
        payload: { attempt_id: uuidv7(), flow: 'idp_device', error: 'expired_token' },
        remoteAddress: `198.51.100.${String(i + 1)}`,
      });
      expect(reply.statusCode).toBe(202);
      expected.push(['failure', 'expired']);
    }
    for (let i = 0; i < 5; i++) {
      expect((await exchange(tokens[i] ?? '')).statusCode).toBe(400);
      expected.push(['failure', 'replay']);
    }
    for (let i = 0; i < 5; i++) {
      const other = idp.mintAccessToken('alice', {
        claims: {
          tid: '11111111-2222-4333-8444-555555555555',
          iss: `https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/v2.0`,
        },
      });
      expect((await exchange(other)).statusCode).toBe(400);
      expected.push(['failure', 'untrusted_issuer']);
    }
    // Throttled reports are not attempts: the 11th from one client in a minute writes nothing.
    for (let i = 0; i < REPORTS_PER_CLIENT_PER_MINUTE + 2; i++) {
      const reply = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in-failures',
        payload: { attempt_id: uuidv7(), flow: 'idp_device', error: 'authorization_declined' },
        remoteAddress: '198.51.100.200',
      });
      if (i < REPORTS_PER_CLIENT_PER_MINUTE) {
        expected.push(['failure', 'idp_error']);
      } else {
        expect(reply.statusCode).toBe(429);
      }
    }

    await expect.poll(async () => (await signIns(undefined, since)).length).toBe(expected.length);
    const stored = await signIns(undefined, since);
    // Compared as multisets: client reports are written asynchronously after their 202.
    const key = ([outcome, reason]: [string, string | null]) => `${outcome}:${reason ?? ''}`;
    expect(stored.map((e) => key([e.outcome, e.reason_code])).sort()).toEqual(
      expected.map(key).sort(),
    );
    for (const event of stored) {
      expect(event.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(event.policy_version).toBe(policyVersion(config.access));
      expect(event.ts).toBeInstanceOf(Date);
      const ip =
        (event.details.client_ip as string | undefined) ??
        ((event.details.server as Record<string, unknown> | undefined)?.client_ip as
          string | undefined);
      expect(ip).toBeDefined();
      expect(
        (event.details.flow as string | undefined) ??
          (event.details.server as Record<string, unknown> | undefined)?.flow,
      ).toBe('idp_device');
    }
    // No JWT, Ralysa token, code or the client secret in any stored event.
    const everything = JSON.stringify(await events());
    expect(everything).not.toMatch(/eyJ[A-Za-z0-9_-]+\.eyJ/);
    expect(everything).not.toMatch(/rly_(rt|ac)_/);
    expect(everything).not.toContain(idp.clientSecret);
    expect(everything).not.toContain(HMAC_KEY);
  });

  // --- TC-F-002-08 -----------------------------------------------------------------------------
  it('TC-F-002-08: bob (no group) is denied with the i18n key; no user, no session', async () => {
    const reply = await exchange(idp.mintAccessToken('bob'));
    expect(reply.statusCode).toBe(400);
    expect(reply.json()).toEqual({
      error: 'access_denied',
      ralysa_error: { code: 'not_in_access_group', i18n_key: 'auth.denied.not_in_access_group' },
    });
    const bob = idp.user('bob');
    expect(await userRow(bob.oid)).toBeUndefined();
    expect(await sessionsOf(bob.oid)).toEqual([]);
    expect((await signIns(bob.oid)).at(-1)).toMatchObject({
      outcome: 'denied',
      reason_code: 'not_in_access_group',
      actor_user_id: null,
      actor_idp_subject: bob.oid,
    });
  });

  // --- TC-F-002-09 -----------------------------------------------------------------------------
  it('TC-F-002-09: carol, refused at the IdP, is reported by the client as idp_error', async () => {
    const since = await dbNow();
    {
      const cfg = await fetchAuthConfig(base);
      const signIn = await startIdpDeviceSignIn(cfg);
      const polled = signIn.poll();
      await expect(
        approveDeviceCode({
          verificationUri: signIn.verificationUri,
          userCode: signIn.userCode,
          username: 'carol',
        }),
      ).rejects.toThrow();
      await expect(polled).rejects.toMatchObject({ name: 'AccessDeniedError' });
      await expect.poll(async () => (await signIns(undefined, since)).length).toBe(1);
      const reported = await signIns(undefined, since);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({
        outcome: 'failure',
        reason_code: 'idp_error',
        attestation: 'client',
      });
    }
  }, 20_000);

  it('TC-F-002-09: disabled after the IdP token was minted → user_disabled; a disabled user cannot refresh', async () => {
    const carol = idp.user('carol');
    idp.patchUser('carol', { enabled: true });
    let live;
    let token;
    try {
      live = await signInAs('carol');
      token = idp.mintAccessToken('carol');
    } finally {
      idp.patchUser('carol', { enabled: false }); // the fixture's state
    }
    const denied = await exchange(token);
    expect(denied.json()).toMatchObject({
      error: 'access_denied',
      ralysa_error: { code: 'user_disabled' },
    });
    const row = await userRow(carol.oid);
    expect(row?.status).toBe('disabled');
    expect(row?.revoked_before).not.toBeNull();
    expect((await sessionsOf(carol.oid)).every((s) => s.status === 'revoked')).toBe(true);
    expect(
      (await events({ action: 'auth.session.revoked', subject: carol.oid })).at(-1)?.details,
    ).toMatchObject({ cause: 'user_disabled', revoked_by: 'system' });
    const refused = await refresh(live.refresh_token);
    expect(refused.statusCode).toBe(400);
    expect((await events({ action: 'auth.refresh', subject: carol.oid })).at(-1)).toMatchObject({
      outcome: 'denied',
    });
  });

  it('TC-F-002-09: dora (Graph 404) is refused and, once known, revoked; Entra "revoke sessions" stops refresh', async () => {
    const dora = idp.user('dora');
    expect((await exchange(idp.mintAccessToken('dora'))).json()).toMatchObject({
      ralysa_error: { code: 'user_disabled' },
    });
    expect(await userRow(dora.oid)).toBeUndefined();

    idp.patchUser('dora', { deletedInGraph: false });
    const session = await signInAs('dora');
    idp.patchUser('dora', { deletedInGraph: true });
    const refused = await refresh(session.refresh_token);
    expect(refused.json()).toMatchObject({ ralysa_error: { code: 'user_disabled' } });
    expect((await userRow(dora.oid))?.status).toBe('disabled');
    expect(
      (await events({ action: 'auth.session.revoked', subject: dora.oid })).at(-1)?.details,
    ).toMatchObject({
      cause: 'user_disabled',
    });
  });

  it('TC-F-002-09: Graph slower than 3 s → error idp_unavailable', async () => {
    idp.setGraphFault({ mode: 'none', latencyMs: 3_500 });
    const started = Date.now();
    const reply = await exchange(idp.mintAccessToken('alice'));
    expect(reply.statusCode).toBe(503);
    expect(reply.json()).toMatchObject({
      ralysa_error: { code: 'idp_unavailable', i18n_key: 'auth.error.idp_unavailable' },
    });
    // One 3 s deadline for the whole Graph check (R29-3), plus the rest of the request.
    expect(Date.now() - started).toBeLessThan(3_750);
    idp.setGraphFault({ mode: 'none' });
    graphClock.offset += 60_000; // leave no half-open failure count for the next test
    await signInAs('alice');
  }, 20_000);

  it('TC-F-002-09: the circuit opens after 5 consecutive Graph failures and answers at once', async () => {
    idp.setGraphFault({ mode: 'error', status: 500 });
    for (let i = 0; i < 5; i++) {
      expect((await exchange(idp.mintAccessToken('alice'))).statusCode).toBe(503);
    }
    expect(directory.circuit().open).toBe(true);
    idp.setGraphFault({ mode: 'none' });
    const open = await exchange(idp.mintAccessToken('alice'));
    expect(open.statusCode).toBe(503);
    expect((await signIns(idp.user('alice').oid)).at(-1)?.details).toMatchObject({
      directory: 'circuit_open',
    });
    graphClock.offset += 31_000;
    expect((await exchange(idp.mintAccessToken('alice'))).statusCode).toBe(200);
  });

  // --- TC-F-002-21 -----------------------------------------------------------------------------
  it('TC-F-002-21: fatima’s Arabic name and group names are byte-identical in /v1/me', async () => {
    const tokens = await signInAs('fatima');
    const view = (await me(tokens.access_token)).json<{
      display_name: string;
      groups: { display_name: string | null; idp_group_id: string }[];
    }>();
    expect(
      Buffer.compare(Buffer.from(view.display_name, 'utf8'), Buffer.from(FATIMA_NAME, 'utf8')),
    ).toBe(0);
    const names = view.groups.map((g) => g.display_name ?? '');
    const expectedNames = idp
      .user('fatima')
      .groups.map((id) => idp.state.groups.get(id)?.displayName ?? '')
      .sort();
    expect([...names].sort()).toEqual(expectedNames);
    for (const name of names) {
      expect(name).not.toContain('�');
      const fixture = expectedNames.find((n) => n === name) ?? '';
      expect(Buffer.compare(Buffer.from(name, 'utf8'), Buffer.from(fixture, 'utf8'))).toBe(0);
    }
    expect(names).toContain(ACCESS_GROUP_NAME);
  });

  // --- TC-F-002-24 -----------------------------------------------------------------------------
  it('TC-F-002-24: tenant pinning, overage through Graph, look-alike names and non-GUID claims', async () => {
    const otherTenant = await exchange(
      idp.mintAccessToken('alice', { claims: { tid: '11111111-2222-4333-8444-555555555555' } }),
    );
    expect(otherTenant.json()).toMatchObject({ ralysa_error: { code: 'untrusted_issuer' } });

    // olga: overage markers, Graph decides; _claim_sources is never followed.
    const olga = await signInAs('olga');
    expect((await me(olga.access_token)).json()).toMatchObject({ roles: ['user'] });
    idp.setGraphFault({ mode: 'error', status: 503 });
    const unresolved = await exchange(idp.mintAccessToken('olga'));
    expect(unresolved.json()).toMatchObject({
      error: 'temporarily_unavailable',
      ralysa_error: {
        code: 'group_overage_unresolved',
        i18n_key: 'auth.error.group_overage_unresolved',
      },
    });
    idp.setGraphFault({ mode: 'none' });

    // mallory: a group NAMED like the access group, another object id.
    const mallory = await exchange(idp.mintAccessToken('mallory'));
    expect(mallory.json()).toMatchObject({ ralysa_error: { code: 'not_in_access_group' } });

    // sam: the token carries an on-prem name; it is ignored, Graph says access group.
    const sam = await signInAs('sam');
    const view = (await me(sam.access_token)).json<{ groups: { idp_group_id: string }[] }>();
    expect(view.groups.map((g) => g.idp_group_id)).toEqual([idp.accessGroupId]);
    expect(metrics.counter('idp_group_claims_ignored_total')).toBeGreaterThan(0);

    // Group ids must be object ids in config (SEC-F002-08).
    expect(
      ServeConfig.safeParse({
        ...configInput(config),
        access: { access_group_id: 'Ralysa Users', admin_group_id: idp.adminGroupId },
      }).success,
    ).toBe(false);
  });

  it('TC-F-002-01 (flow A): a membership change is stored and audited at the next sign-in', async () => {
    const extra = uuidv7();
    idp.patchUser('alice', { groups: [idp.accessGroupId, extra] });
    try {
      await signInAs('alice');
      // A later token with overage markers (or no groups claim) says nothing about the claimed
      // groups: the earlier token_claim rows are kept; only Graph-checked rows change (R29-4).
      const overage = await exchange(
        idp.mintAccessToken('alice', {
          claims: { groups: undefined, _claim_names: { groups: 'src1' } },
        }),
      );
      expect(overage.statusCode).toBe(200);
      const kept = (await me(overage.json<{ access_token: string }>().access_token)).json<{
        groups: { idp_group_id: string }[];
      }>();
      expect(kept.groups.map((g) => g.idp_group_id).sort()).toEqual(
        [idp.accessGroupId, extra].sort(),
      );
      const changed = (
        await events({
          action: 'directory.group_membership.changed',
          subject: idp.user('alice').oid,
        })
      ).at(-1);
      expect(changed?.details).toMatchObject({ added: [extra], removed: [], privileged: false });
    } finally {
      idp.patchUser('alice', { groups: [idp.accessGroupId] });
    }
    const tokens = await signInAs('alice');
    const view = (await me(tokens.access_token)).json<{ groups: { idp_group_id: string }[] }>();
    expect(view.groups.map((g) => g.idp_group_id)).toEqual([idp.accessGroupId]);
  });

  // --- TC-F-002-31 -----------------------------------------------------------------------------
  it('TC-F-002-31: admin rights only on strong sign-ins; MFA evidence; ipaddr mismatch flagged', async () => {
    const dana = await exchange(idp.mintAccessToken('dana'));
    expect(dana.json()).toMatchObject({
      error: 'access_denied',
      ralysa_error: {
        code: 'admin_requires_strong_flow',
        i18n_key: 'auth.denied.admin_requires_strong_flow',
      },
    });

    idp.patchUser('erin', { amr: ['pwd', 'mfa'], acrs: null });
    let weak: Awaited<ReturnType<typeof signInAs>>;
    try {
      weak = await signInAs('erin');
      expect((await me(weak.access_token)).json()).toMatchObject({ roles: ['user'] });
      expect((await signIns(idp.user('erin').oid)).at(-1)?.details).toMatchObject({
        roles: ['user'],
        admin_role_withheld: true,
      });
    } finally {
      idp.patchUser('erin', { amr: ['fido'], acrs: ['c1'] });
    }
    const strong = await signInAs('erin');
    expect((await me(strong.access_token)).json()).toMatchObject({
      roles: ['user', 'platform_admin'],
    });

    // #47, SEC-F002-42: what a PEP sees. The device-code session holds no admin role although
    // erin is in the admin group; only the strong session does.
    const weakPrincipal = await principalFor(weak.access_token);
    expect(weakPrincipal).toMatchObject({
      roles: ['user', 'platform_admin'],
      session_id: decodeJwt(weak.access_token).sid,
      session_roles: ['user'],
    });
    expect((await principalFor(strong.access_token)).session_roles).toEqual([
      'user',
      'platform_admin',
    ]);
    // A refresh of the device-code session doesn't add it either.
    const refreshed = await refresh(weak.refresh_token);
    expect(refreshed.statusCode).toBe(200);
    expect(
      (await principalFor(refreshed.json<{ access_token: string }>().access_token)).session_roles,
    ).toEqual(['user']);

    const noMfa = await exchange(idp.mintAccessToken('alice', { claims: { amr: ['pwd'] } }));
    expect(noMfa.json()).toMatchObject({
      ralysa_error: { code: 'mfa_claim_missing', i18n_key: 'auth.failed.mfa_claim_missing' },
    });

    const before = metrics.counter('auth_device_ip_mismatch_total');
    const mismatch = await exchange(idp.mintAccessToken('alice'), {}, app, '203.0.113.50');
    expect(mismatch.statusCode).toBe(200);
    expect((await signIns(idp.user('alice').oid)).at(-1)?.details).toMatchObject({
      client_ip: '203.0.113.50',
      idp_ipaddr: '127.0.0.1',
      ip_mismatch: true,
    });
    expect(metrics.counter('auth_device_ip_mismatch_total')).toBe(before + 1);
  });

  // Last: revoking fatima's Entra sessions sets her revoked_before (DB clock + 30 s), so tokens
  // issued in the next 30 s are refused by design; no later test signs her in.
  it('TC-F-002-09: Entra "revoke sessions" stops refresh and older IdP tokens', async () => {
    const fatima = await signInAs('fatima');
    idp.revokeSessions('fatima');
    const revoked = await refresh(fatima.refresh_token);
    expect(revoked.json()).toMatchObject({ ralysa_error: { code: 'idp_session_revoked' } });
    // An IdP token issued before the revocation can't start a new session either.
    const stale = idp.mintAccessToken('fatima', {
      claims: { iat: Math.floor(Date.now() / 1000) - 60 },
    });
    expect((await exchange(stale)).json()).toMatchObject({ ralysa_error: { code: 'expired' } });
  });
});

/** The parsed config back as input (for variants). */
function configInput(config: ServeConfig): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}
