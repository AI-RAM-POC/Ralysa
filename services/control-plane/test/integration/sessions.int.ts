// F-002-T08 against the dev stack: sessions and grants with real Postgres, service assertions
// signed through real OpenBao Transit keys (throwaway per run). Sessions are seeded directly until
// T10 adds sign-in; the IdP directory is a controllable fake until T10 wires Graph.
//   - TC-F-002-13: revoke = sign-out, a later refresh is refused and audited, /v1/me and the
//     governance feed see the revocation;
//   - TC-F-002-25: reuse revokes the family; concurrent refreshes → exactly one wins, the loser
//     gets invalid_grant (one-refresher contract, SEC-F002-17); a used code's second redemption
//     revokes its session (SEC-F002-20);
//   - TC-F-002-26 (RTS half): client assertions, replay, foreign key, wrong aud, retired version
//     (SEC-F002-22); the OpenBao policy half is tooling/dev-stack's policies.int.ts;
//   - refresh re-checks the IdP, audiences by role, the cleanup job.
import { createHash } from 'node:crypto';
import { CLI_CLIENT_ID, JWT_BEARER_ASSERTION_TYPE } from '@ralysa/protocol/auth';
import { uuidv7 } from '@ralysa/protocol/common';
import { GovernanceState } from '@ralysa/protocol/control-plane';
import { type KeyCustody, createOpenBao } from '@ralysa/secrets';
import { devStackOrSkip, expectOk, rootBao, uniqueName } from '@ralysa/dev-stack/harness';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { type EmittedRejection, createRejectionAggregator } from '../../src/audit/rejections.js';
import { createAuditWriter } from '../../src/audit/writer.js';
import { runCleanup } from '../../src/auth/cleanup.js';
import type { DirectoryCheck, IdpDirectory } from '../../src/auth/directory-port.js';
import { policyVersion } from '../../src/auth/policy-version.js';
import {
  createSession,
  issueRefreshToken,
  redeemAuthorizationCode,
} from '../../src/auth/sessions.js';
import { mintAccessToken } from '../../src/auth/tokens/mint.js';
import { newAuthorizationCode, tokenHash } from '../../src/auth/tokens/opaque.js';
import { createRateLimiter } from '../../src/http/rate-limits.js';
import { createDb, withOrg } from '../../src/db/kysely.js';
import type { Database } from '../../src/db/types.js';
import { ensureOrganization } from '../../src/org/bootstrap.js';
import { fakeKeys } from '../fixtures/fake-keys.js';
import { TENANT, serveConfig } from '../fixtures/serve-config.js';
import { type TestDatabase, createTestDatabase } from './support/db.js';

const stack = await devStackOrSkip();
const svcA = uniqueName('t08a');
const svcB = uniqueName('t08b');
const service = (name: string) => ({
  name,
  client_id: `svc:${name}`,
  transit_key: `ralysa-svc-${name}`,
  audit_actions: ['model.call.completed'],
});
const config = serveConfig({
  env: 'test',
  org: {
    id: uuidv7(),
    name: 'Org S',
    residency: 'in_country',
    region: 'qa-doha',
    deployment_model: 'on_prem',
  },
  services: [service(svcA), service(svcB)],
});
const ORG = config.org.id;
const TOKEN_ENDPOINT = `${config.public_base_url}/oauth2/token`;
const utf8 = (text: string) => new TextEncoder().encode(text);
const b64u = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === 'string' ? utf8(bytes) : bytes).toString('base64url');

describe.skipIf(stack === undefined)('sessions and grants (F-002-T08)', () => {
  let db: TestDatabase | undefined;
  let cpDb: Kysely<Database>;
  let custody: KeyCustody;
  let app: FastifyInstance;
  const rejected: EmittedRejection[] = [];
  let directoryAnswer: DirectoryCheck;
  // The fake directory can hold callers at a gate, so tests can line up concurrent requests.
  let directoryGate: { arrive: () => Promise<void> } | undefined;
  const directory: IdpDirectory = {
    check: async () => {
      await directoryGate?.arrive();
      return directoryAnswer;
    },
  };
  /** Opens once `parties` callers have arrived. */
  const barrier = (parties: number) => {
    let arrived = 0;
    let open = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return {
      arrive: () => {
        arrived++;
        if (arrived >= parties) open();
        return opened;
      },
    };
  };
  /** Holds every caller until `open()`; `arrived` resolves when the first one is waiting. */
  const latch = () => {
    let open = (): void => undefined;
    let signal = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      signal = resolve;
    });
    return {
      arrive: () => {
        signal();
        return opened;
      },
      arrived,
      open: () => {
        open();
      },
    };
  };
  // The app's cache clock: tests step it past the feed's 1 s cache instead of sleeping.
  let clockOffset = 0;
  const advance = (ms: number) => {
    clockOffset += ms;
  };
  let signing: Awaited<ReturnType<typeof fakeKeys>>;
  const writerDb = async () => createDb<Database>(await t().pool('audit_writer', 2));
  const t = (): TestDatabase => {
    if (db === undefined) throw new Error('beforeAll did not create the database');
    return db;
  };

  // --- helpers -------------------------------------------------------------------------------
  const form = (url: string, params: Record<string, string>, headers = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      payload: new URLSearchParams(params).toString(),
    });
  const refresh = (token: string, extra: Record<string, string> = {}) =>
    form('/oauth2/token', {
      grant_type: 'refresh_token',
      client_id: CLI_CLIENT_ID,
      refresh_token: token,
      ...extra,
    });
  const revoke = (token: string, clientId: string = CLI_CLIENT_ID) =>
    form('/oauth2/revoke', { client_id: clientId, token });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  const events = async (where: { sid?: string; action?: string; user?: string }) =>
    (
      await t().superuser.query<{
        action: string;
        outcome: string;
        reason_code: string | null;
        details: Record<string, unknown>;
        policy_version: string | null;
      }>(
        `SELECT action, outcome, reason_code, details, policy_version FROM audit.audit_event
          WHERE ($1::text IS NULL OR session_id::text = $1) AND ($2::text IS NULL OR action = $2)
            AND ($3::text IS NULL OR actor_user_id::text = $3)
          ORDER BY ingest_seq`,
        [where.sid ?? null, where.action ?? null, where.user ?? null],
      )
    ).rows;

  const seedUser = async (displayName = 'مستخدم تجريبي') => {
    const id = uuidv7();
    const idpSubject = uuidv7();
    await withOrg(cpDb, ORG, (trx) =>
      trx
        .insertInto('cp.app_user')
        .values({
          id,
          org_id: ORG,
          idp_issuer: config.idp.issuer,
          idp_tenant_id: TENANT,
          idp_subject: idpSubject,
          email: null,
          display_name: displayName,
          department_id: null,
          revoked_before: null,
          last_sign_in_at: null,
        })
        .execute(),
    );
    return { id, idpSubject };
  };

  const seedSession = async (
    userId: string,
    options: { roles?: ('user' | 'platform_admin')[]; status?: 'active' | 'pending' } = {},
  ) =>
    withOrg(cpDb, ORG, async (trx) => {
      const sid = await createSession(trx, {
        orgId: ORG,
        userId,
        clientId: CLI_CLIENT_ID,
        surface: 'cli',
        flow: 'idp_device',
        status: options.status ?? 'active',
        roles: options.roles ?? ['user'],
        absoluteSeconds: config.tokens.refresh_absolute_s,
      });
      const { token } = await issueRefreshToken(trx, {
        orgId: ORG,
        sessionId: sid,
        parentId: null,
        idleSeconds: config.tokens.refresh_idle_s,
      });
      return { sid, token };
    });

  const assertion = async (
    options: {
      as?: string;
      signWith?: string;
      version?: number;
      aud?: string;
      jti?: string;
      header?: Record<string, unknown>;
      claims?: Record<string, unknown>;
    } = {},
  ) => {
    const name = options.as ?? svcA;
    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: 'ES256',
      typ: 'JWT',
      kid: `ralysa-svc-${name}.v${String(options.version ?? 1)}`,
    };
    const payload = {
      iss: `svc:${name}`,
      sub: `svc:${name}`,
      aud: options.aud ?? TOKEN_ENDPOINT,
      iat: now,
      exp: now + 50,
      jti: options.jti ?? uuidv7(),
    };
    const input = `${b64u(JSON.stringify({ ...header, ...options.header }))}.${b64u(
      JSON.stringify({ ...payload, ...options.claims }),
    )}`;
    const signature = await custody.sign(
      `ralysa-svc-${options.signWith ?? name}`,
      options.version ?? 1,
      utf8(input),
    );
    return `${input}.${b64u(signature)}`;
  };
  const clientCredentials = async (clientAssertion: string, extra: Record<string, string> = {}) =>
    form('/oauth2/token', {
      grant_type: 'client_credentials',
      client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
      client_assertion: clientAssertion,
      ...extra,
    });
  const serviceToken = async () => {
    const reply = await clientCredentials(await assertion());
    expect(reply.statusCode).toBe(200);
    return reply.json<{ access_token: string }>().access_token;
  };
  const feed = async (token: string, since?: string) => {
    const reply = await app.inject({
      url: `/v1/internal/governance${since === undefined ? '' : `?since=${encodeURIComponent(since)}`}`,
      headers: bearer(token),
    });
    expect(reply.statusCode).toBe(200);
    return GovernanceState.parse(reply.json());
  };

  // --- setup ---------------------------------------------------------------------------------
  beforeAll(async () => {
    const root = rootBao(stack!);
    for (const name of [svcA, svcB]) {
      expectOk(await root('POST', `transit/keys/ralysa-svc-${name}`, { type: 'ecdsa-p256' }), name);
    }
    custody = createOpenBao({
      addr: stack!.openbao.addr,
      auth: { method: 'token', token: stack!.openbao.rootToken },
      env: 'test',
    }).keys;
    db = await createTestDatabase(stack!);
    await db.migrate(ORG);
    cpDb = createDb<Database>(await db.pool('cp_app', 6));
    await ensureOrganization(cpDb, config);
    const writer = createAuditWriter({ db: await writerDb() });
    signing = await fakeKeys();
    app = await buildApp({
      config,
      keys: signing.keys,
      rts: {
        db: cpDb,
        custody,
        directory,
        writer,
        now: () => Date.now() + clockOffset,
        rejections: createRejectionAggregator({ emit: (r) => rejected.push(r), perKeyLimit: 1000 }),
      },
      rateLimiter: createRateLimiter({ perIpPerMinute: 10_000, globalPerMinute: 10_000 }),
      pingDatabase: () => Promise.resolve(true),
    });
  }, 60_000);

  beforeEach(() => {
    directoryGate = undefined;
    directoryAnswer = {
      kind: 'ok',
      inAccessGroup: true,
      inAdminGroup: false,
      sessionsValidFrom: null,
    };
  });

  afterAll(async () => {
    await app.close();
    const root = rootBao(stack!);
    for (const name of [svcA, svcB]) {
      await root('POST', `transit/keys/ralysa-svc-${name}/config`, { deletion_allowed: true });
      await root('DELETE', `transit/keys/ralysa-svc-${name}`);
    }
    await db?.drop();
  });

  // --- refresh -------------------------------------------------------------------------------
  it('refresh rotates the token; /v1/me answers with the session roles and the stored UTF-8 name', async () => {
    const user = await seedUser();
    const { sid, token } = await seedSession(user.id);
    const group = uuidv7();
    await withOrg(cpDb, ORG, async (trx) => {
      await trx
        .insertInto('cp.idp_group')
        .values({
          id: group,
          org_id: ORG,
          idp_group_id: config.access.access_group_id,
          display_name: 'فريق المالية',
          role: 'access',
          name_refreshed_at: null,
        })
        .onConflict((oc) => oc.columns(['org_id', 'idp_group_id']).doNothing())
        .execute();
      const g = await trx
        .selectFrom('cp.idp_group')
        .select('id')
        .where('idp_group_id', '=', config.access.access_group_id)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('cp.group_membership')
        .values({ org_id: ORG, user_id: user.id, group_id: g.id, source: 'graph_check' })
        .execute();
    });

    const reply = await refresh(token);
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    const body = reply.json<{ access_token: string; refresh_token: string; expires_in: number }>();
    expect(body.refresh_token).toMatch(/^rly_rt_[A-Za-z0-9_-]{43}$/);
    expect(body.refresh_token).not.toBe(token);
    expect(body.expires_in).toBe(config.tokens.access_ttl_s);
    expect(decodeJwt(body.access_token)).toMatchObject({
      aud: 'control-plane',
      sub: user.id,
      sid,
      tid: ORG,
      token_use: 'access',
    });

    const me = await app.inject({ url: '/v1/me', headers: bearer(body.access_token) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      id: user.id,
      org_id: ORG,
      display_name: 'مستخدم تجريبي',
      roles: ['user'],
      groups: [
        {
          idp_group_id: config.access.access_group_id,
          display_name: 'فريق المالية',
          role: 'access',
        },
      ],
    });
    // The rotated token is stored as a hash only.
    const { rows } = await t().superuser.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cp.refresh_token WHERE token_hash = $1`,
      [tokenHash(body.refresh_token)],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('TC-F-002-13: revoke signs out; a later refresh is invalid_grant (revoked) and audited; /v1/me and the feed see it', async () => {
    const svc = await serviceToken();
    const user = await seedUser();
    const { sid, token } = await seedSession(user.id);
    const first = (await refresh(token)).json<{ access_token: string; refresh_token: string }>();
    const before = await feed(svc);

    expect((await revoke(first.refresh_token)).statusCode).toBe(200);
    // Revoking again (or an unknown token) is still 200 and writes nothing more (RFC 7009).
    expect((await revoke(first.refresh_token)).statusCode).toBe(200);
    expect((await revoke(`rly_rt_${'A'.repeat(43)}`)).statusCode).toBe(200);
    expect((await revoke(first.refresh_token, 'someone-else')).statusCode).toBe(401);
    expect((await events({ sid, action: 'auth.sign_out' })).map((e) => e.details)).toEqual([
      { sid, surface: 'cli' },
    ]);

    const later = await refresh(first.refresh_token);
    expect(later.statusCode).toBe(400);
    expect(later.json()).toMatchObject({
      error: 'invalid_grant',
      ralysa_error: { code: 'revoked', i18n_key: 'auth.denied.revoked' },
    });
    expect(await events({ sid, action: 'auth.refresh' })).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        reason_code: 'revoked',
        policy_version: policyVersion(config.access),
      }),
    ]);
    // The control plane's own routes read revocation from the database [SEC-F002-18 d].
    rejected.length = 0;
    const me = await app.inject({ url: '/v1/me', headers: bearer(first.access_token) });
    expect(me.statusCode).toBe(401);
    expect(me.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect(rejected.map((r) => r.reason)).toEqual(['session_revoked']);

    // A token whose sid is ANOTHER user's live session is session_revoked too (review of #32).
    const other = await seedUser();
    const otherSession = await seedSession(other.id);
    const now = Math.floor(Date.now() / 1000);
    const crossed = await mintAccessToken(signing.keys, {
      iss: config.public_base_url,
      aud: 'control-plane',
      sub: user.id,
      client_id: CLI_CLIENT_ID,
      tid: ORG,
      sid: otherSession.sid,
      idp_sub: 'b1e2c3d4-0000-4000-8000-00000000e001',
      surface: 'cli',
      auth_time: now,
      region: config.org.region,
      token_use: 'access',
      iat: now,
      nbf: now,
      exp: now + 600,
      jti: uuidv7(),
    });
    rejected.length = 0;
    const crossedMe = await app.inject({ url: '/v1/me', headers: bearer(crossed) });
    expect(crossedMe.statusCode).toBe(401);
    expect(rejected.map((r) => r.reason)).toEqual(['session_revoked']);

    // A PEP's next poll: the sid is listed, issued_at is fresh, and the epoch went up.
    const after = await feed(svc, before.cursor);
    expect(after.revoked_sessions.map((s) => s.sid)).toContain(sid);
    expect(after.epoch).toBeGreaterThan(before.epoch);
    expect(Math.abs(Date.parse(after.issued_at) - Date.now())).toBeLessThan(30_000);
    const fakeGateway = (state: GovernanceState, claims: { sid: string }) =>
      !state.revoked_sessions.some((s) => s.sid === claims.sid);
    expect(fakeGateway(before, { sid })).toBe(true);
    expect(fakeGateway(after, { sid })).toBe(false);
  });

  it('the feed cursor lags issued_at, so a revocation that commits after a poll is still delivered (SEC-F002-18)', async () => {
    const svc = await serviceToken();
    advance(1_100);
    const first = await feed(svc);
    expect(Date.parse(first.issued_at) - Date.parse(first.cursor)).toBe(60_000);
    // A revocation stamped (revoked_at) just before that poll read, committed just after it.
    const user = await seedUser();
    const { sid } = await seedSession(user.id);
    await t().superuser.query(
      `UPDATE cp.auth_session SET status = 'revoked', revoked_at = $2::timestamptz - interval '1 second'
        WHERE id = $1`,
      [sid, first.issued_at],
    );
    const next = await feed(svc, first.cursor);
    expect(next.revoked_sessions.map((r) => r.sid)).toContain(sid);
  });

  it('TC-F-002-25: presenting a rotated token revokes the family; both tokens then fail', async () => {
    const user = await seedUser();
    const { sid, token: a } = await seedSession(user.id);
    const b = (await refresh(a)).json<{ refresh_token: string }>().refresh_token;

    const reuse = await refresh(a);
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json()).toMatchObject({
      error: 'invalid_grant',
      ralysa_error: { code: 'reuse_detected' },
    });
    expect((await refresh(b)).json()).toMatchObject({ error: 'invalid_grant' });
    const actions = (await events({ sid })).map((e) => [e.action, e.outcome, e.reason_code]);
    expect(actions).toEqual(
      expect.arrayContaining([
        ['auth.token.reuse_detected', 'denied', null],
        ['auth.session.revoked', 'success', null],
        ['auth.refresh', 'denied', 'reuse_detected'],
      ]),
    );
    expect((await events({ sid, action: 'auth.token.reuse_detected' }))[0]?.details).toMatchObject({
      sid,
      revoked_count: 1,
      token_kind: 'refresh',
    });
  });

  it('TC-F-002-25: two concurrent refreshes of one token → exactly one succeeds; the loser gets invalid_grant (SEC-F002-17)', async () => {
    const user = await seedUser();
    const { sid, token } = await seedSession(user.id);
    // Both requests pass the lookup before either rotates: the loser loses the guard itself.
    directoryGate = barrier(2);
    const replies = await Promise.all([refresh(token), refresh(token)]);
    const codes = replies.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 400]);
    const loser = replies.find((r) => r.statusCode === 400);
    expect(loser?.json()).toMatchObject({
      error: 'invalid_grant',
      ralysa_error: { code: 'reuse_detected' },
    });
    // A second refresher on one device breaks the one-refresher contract: it surfaces as reuse,
    // so the family (the winner's new token included) is revoked.
    const winner = replies.find((r) => r.statusCode === 200)?.json<{ refresh_token: string }>();
    expect((await refresh(winner?.refresh_token ?? '')).statusCode).toBe(400);
    const { rows } = await t().superuser.query<{ status: string; revoked_reason: string }>(
      `SELECT status, revoked_reason FROM cp.auth_session WHERE id = $1`,
      [sid],
    );
    expect(rows[0]).toEqual({ status: 'revoked', revoked_reason: 'reuse_detected' });
  });

  it('TC-F-002-25: a second redemption of a used authorization code revokes its session (SEC-F002-20)', async () => {
    const user = await seedUser();
    const { sid } = await seedSession(user.id, { status: 'pending' });
    const code = newAuthorizationCode();
    await withOrg(cpDb, ORG, (trx) =>
      trx
        .insertInto('cp.authorization_code')
        .values({
          code_hash: tokenHash(code),
          org_id: ORG,
          client_id: CLI_CLIENT_ID,
          redirect_uri: 'http://127.0.0.1:49152/callback',
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          session_id: sid,
          callback_ip: '127.0.0.1',
          expires_at: new Date(Date.now() + 60_000),
          used_at: null,
        })
        .execute(),
    );
    await expect(
      withOrg(cpDb, ORG, (trx) => redeemAuthorizationCode(trx, code)),
    ).resolves.toMatchObject({
      kind: 'ok',
      sessionId: sid,
    });
    await expect(withOrg(cpDb, ORG, (trx) => redeemAuthorizationCode(trx, code))).resolves.toEqual({
      kind: 'reused',
      sessionId: sid,
      revoked: true,
    });
    // The tombstone stays until expiry + 1 h.
    const { rows } = await t().superuser.query<{ used: boolean; status: string }>(
      `SELECT c.used_at IS NOT NULL AS used, s.status FROM cp.authorization_code c
         JOIN cp.auth_session s ON s.id = c.session_id WHERE c.code_hash = $1`,
      [tokenHash(code)],
    );
    expect(rows[0]).toEqual({ used: true, status: 'revoked' });
    await expect(
      withOrg(cpDb, ORG, (trx) => redeemAuthorizationCode(trx, newAuthorizationCode())),
    ).resolves.toEqual({ kind: 'invalid' });
  });

  it('refresh re-checks the IdP: unavailable consumes nothing; disabled revokes the user (revoked_before in the feed); no group revokes the session', async () => {
    const svc = await serviceToken();
    const user = await seedUser();
    const { token } = await seedSession(user.id);

    directoryAnswer = { kind: 'unavailable', reason: 'timeout' };
    const down = await refresh(token);
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({
      error: 'temporarily_unavailable',
      ralysa_error: { code: 'idp_unavailable', i18n_key: 'auth.error.idp_unavailable' },
    });
    directoryAnswer = {
      kind: 'ok',
      inAccessGroup: true,
      inAdminGroup: false,
      sessionsValidFrom: null,
    };
    const next = (await refresh(token)).json<{ refresh_token: string }>().refresh_token;
    expect(next).toMatch(/^rly_rt_/);

    directoryAnswer = { kind: 'disabled' };
    expect((await refresh(next)).json()).toMatchObject({ ralysa_error: { code: 'user_disabled' } });
    const { rows } = await t().superuser.query<{ status: string; skew: number }>(
      `SELECT status, extract(epoch FROM revoked_before - now())::float AS skew FROM cp.app_user WHERE id = $1`,
      [user.id],
    );
    expect(rows[0]?.status).toBe('disabled');
    expect(rows[0]?.skew).toBeGreaterThan(20); // DB clock + 30 s [SEC-F002-18 c]
    advance(1_100); // past the feed's 1 s response cache
    const state = await feed(svc);
    expect(state.users_revoked_before.map((u) => u.user_id)).toContain(user.id);
    expect(await events({ user: user.id, action: 'auth.session.revoked' })).toEqual([
      expect.objectContaining({
        details: { user_id: user.id, revoked_by: 'system', cause: 'user_disabled' },
      }),
    ]);

    const other = await seedUser();
    const { sid, token: t2 } = await seedSession(other.id);
    directoryAnswer = {
      kind: 'ok',
      inAccessGroup: false,
      inAdminGroup: false,
      sessionsValidFrom: null,
    };
    expect((await refresh(t2)).json()).toMatchObject({
      ralysa_error: { code: 'not_in_access_group' },
    });
    advance(1_100); // past the feed's 1 s response cache
    expect((await feed(svc)).revoked_sessions.map((s) => s.sid)).toContain(sid);

    const third = await seedUser();
    const { token: t3 } = await seedSession(third.id);
    directoryAnswer = {
      kind: 'ok',
      inAccessGroup: true,
      inAdminGroup: false,
      sessionsValidFrom: new Date(Date.now() + 1_000),
    };
    expect((await refresh(t3)).json()).toMatchObject({
      ralysa_error: { code: 'idp_session_revoked' },
    });
  });

  it('audience: a user session gets model-gateway tokens; an admin-only session gets invalid_scope (§6.1)', async () => {
    const user = await seedUser();
    const { token } = await seedSession(user.id);
    const reply = await refresh(token, { audience: 'model-gateway' });
    expect(reply.statusCode).toBe(200);
    expect(decodeJwt(reply.json<{ access_token: string }>().access_token).aud).toBe(
      'model-gateway',
    );

    const admin = await seedUser();
    const { token: adminToken } = await seedSession(admin.id, { roles: ['platform_admin'] });
    directoryAnswer = {
      kind: 'ok',
      inAccessGroup: false,
      inAdminGroup: true,
      sessionsValidFrom: null,
    };
    expect((await refresh(adminToken, { audience: 'model-gateway' })).json()).toMatchObject({
      error: 'invalid_scope',
    });
    // The refusal consumed nothing: control-plane still works for the admin session.
    expect((await refresh(adminToken)).statusCode).toBe(200);
  });

  it('the token endpoint refuses password, unknown grants, client secrets and Basic auth (AC-3)', async () => {
    const password = await form('/oauth2/token', {
      grant_type: 'password',
      username: 'u',
      password: 'p',
    });
    expect(password.json()).toEqual({ error: 'unsupported_grant_type' });
    for (const grant of ['urn:ietf:params:oauth:grant-type:device_code', 'implicit']) {
      expect((await form('/oauth2/token', { grant_type: grant })).json()).toEqual({
        error: 'unsupported_grant_type',
      });
    }
    // Served grants (T10) refuse an incomplete request.
    expect((await form('/oauth2/token', { grant_type: 'authorization_code' })).json()).toEqual({
      error: 'invalid_request',
    });
    const secret = await form('/oauth2/token', {
      grant_type: 'client_credentials',
      client_id: `svc:${svcA}`,
      client_secret: 'x',
    });
    expect(secret.statusCode).toBe(401);
    expect(secret.json()).toMatchObject({ error: 'invalid_client' });
    const basic = await form(
      '/oauth2/token',
      { grant_type: 'client_credentials' },
      { authorization: `Basic ${b64u('a:b')}` },
    );
    expect(basic.statusCode).toBe(401);
    const json = await app.inject({
      method: 'POST',
      url: '/oauth2/token',
      payload: { grant_type: 'refresh_token' },
    });
    expect(json.statusCode).toBe(400);
    const repeated = await app.inject({
      method: 'POST',
      url: '/oauth2/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'grant_type=refresh_token&grant_type=client_credentials',
    });
    expect(repeated.json()).toMatchObject({ error: 'invalid_request' });
  });

  // --- services ------------------------------------------------------------------------------
  it('TC-F-002-26: a valid assertion → a 5-minute service token; replay, a foreign key, a wrong aud and a retired version are refused', async () => {
    const reply = await clientCredentials(await assertion());
    expect(reply.statusCode).toBe(200);
    const body = reply.json<{ access_token: string; expires_in: number; refresh_token?: string }>();
    expect(body.expires_in).toBe(300);
    expect(body.refresh_token).toBeUndefined();
    expect(decodeJwt(body.access_token)).toMatchObject({
      sub: `svc:${svcA}`,
      aud: 'control-plane',
      token_use: 'service',
      tid: ORG,
    });
    expect((await feed(body.access_token)).epoch).toBeGreaterThanOrEqual(0);

    const refused = async (clientAssertion: string, reason: string) => {
      rejected.length = 0;
      const r = await clientCredentials(clientAssertion);
      expect({ status: r.statusCode, body: r.json<unknown>() }).toEqual({
        status: 401,
        body: { error: 'invalid_client' },
      });
      expect(rejected.map((x) => [x.reason, x.audience, x.orgId])).toEqual([
        [reason, 'rts-token-endpoint', ORG],
      ]);
    };
    const jti = uuidv7();
    expect((await clientCredentials(await assertion({ jti }))).statusCode).toBe(200);
    await refused(await assertion({ jti }), 'malformed'); // replayed jti
    await refused(await assertion({ signWith: svcB }), 'bad_signature'); // B's key, A's kid
    await refused(await assertion({ aud: `${config.public_base_url}/v1/me` }), 'wrong_audience');

    // Retire version 1 of B's key (rotate, then trim; A keeps working for the later tests). B's key
    // list is first read after the trim, so version 1 is not in it. (A list cached before the
    // retirement expires within SERVICE_KEY_CACHE_TTL_MS: the unit test covers that.)
    const root = rootBao(stack!);
    const key = `transit/keys/ralysa-svc-${svcB}`;
    expectOk(await root('POST', `${key}/rotate`, {}), 'rotate');
    expectOk(
      await root('POST', `${key}/config`, { min_decryption_version: 2, min_encryption_version: 2 }),
      'config',
    );
    expectOk(await root('POST', `${key}/trim`, { min_available_version: 2 }), 'trim');
    expect((await clientCredentials(await assertion({ as: svcB, version: 2 }))).statusCode).toBe(
      200,
    );
    // OpenBao can no longer sign with version 1, so present a v1 kid over a v2 signature: RTS
    // must refuse it on the kid (version 1 is no longer listed), not on the signature.
    const header = { alg: 'ES256', typ: 'JWT', kid: `ralysa-svc-${svcB}.v1` };
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64u(JSON.stringify(header))}.${b64u(
      JSON.stringify({
        iss: `svc:${svcB}`,
        sub: `svc:${svcB}`,
        aud: TOKEN_ENDPOINT,
        iat: now,
        exp: now + 50,
        jti: uuidv7(),
      }),
    )}`;
    const sig = await custody.sign(`ralysa-svc-${svcB}`, 2, utf8(input));
    await refused(`${input}.${b64u(sig)}`, 'unknown_kid');
  });

  it('service and user tokens are kept to their own routes; principals report groups and roles', async () => {
    const svc = await serviceToken();
    const user = await seedUser('Test User');
    const { token } = await seedSession(user.id);
    const access = (await refresh(token)).json<{ access_token: string }>().access_token;

    expect((await app.inject({ url: '/v1/me', headers: bearer(svc) })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/v1/internal/governance', headers: bearer(access) })).statusCode,
    ).toBe(401);
    expect((await app.inject({ url: '/v1/internal/governance' })).statusCode).toBe(401);

    const principal = await app.inject({
      url: `/v1/internal/principals/${user.id}`,
      headers: bearer(svc),
    });
    expect(principal.statusCode).toBe(200);
    expect(principal.json()).toMatchObject({
      user_id: user.id,
      org_id: ORG,
      status: 'active',
      roles: [],
      groups: [],
    });
    expect(
      (await app.inject({ url: `/v1/internal/principals/${uuidv7()}`, headers: bearer(svc) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: '/v1/internal/principals/not-a-uuid', headers: bearer(svc) }))
        .statusCode,
    ).toBe(400);
    const bad = await app.inject({
      url: '/v1/internal/governance?since=yesterday',
      headers: bearer(svc),
    });
    expect(bad.statusCode).toBe(400);
  });

  // --- review of #26 -------------------------------------------------------------------------
  it('B1: a signing failure answers 503 and consumes nothing; the same token then refreshes', async () => {
    const user = await seedUser();
    const { sid, token } = await seedSession(user.id);
    signing.state.violation = 'test: signing unavailable';
    try {
      const failed = await refresh(token);
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toEqual({ error: 'temporarily_unavailable' });
    } finally {
      signing.state.violation = undefined;
    }
    const retried = await refresh(token);
    expect(retried.statusCode).toBe(200);
    expect(await events({ sid, action: 'auth.token.reuse_detected' })).toEqual([]);
  });

  it('a token revoked while its refresh is in flight is answered revoked, not reuse (review item 1)', async () => {
    const user = await seedUser();
    const { sid, token } = await seedSession(user.id);
    const gate = latch();
    directoryGate = gate;
    const inFlight = refresh(token);
    await gate.arrived;
    expect((await revoke(token)).statusCode).toBe(200);
    gate.open();
    const reply = await inFlight;
    expect(reply.json()).toMatchObject({
      error: 'invalid_grant',
      ralysa_error: { code: 'revoked' },
    });
    expect(await events({ sid, action: 'auth.token.reuse_detected' })).toEqual([]);
  });

  it('presenting a rotated token after sign-out is still reuse, with no second session.revoked', async () => {
    const user = await seedUser();
    const { sid, token: a } = await seedSession(user.id);
    const b = (await refresh(a)).json<{ refresh_token: string }>().refresh_token;
    expect((await revoke(b)).statusCode).toBe(200);
    expect((await refresh(a)).json()).toMatchObject({ ralysa_error: { code: 'reuse_detected' } });
    expect(await events({ sid, action: 'auth.token.reuse_detected' })).toHaveLength(1);
    expect(await events({ sid, action: 'auth.session.revoked' })).toEqual([]);
  });

  it("/v1/me refuses an access token issued before the user's revoked_before", async () => {
    const user = await seedUser();
    const { token } = await seedSession(user.id);
    const access = (await refresh(token)).json<{ access_token: string }>().access_token;
    expect((await app.inject({ url: '/v1/me', headers: bearer(access) })).statusCode).toBe(200);
    await t().superuser.query(
      `UPDATE cp.app_user SET revoked_before = now() + interval '30 seconds' WHERE id = $1`,
      [user.id],
    );
    rejected.length = 0;
    expect((await app.inject({ url: '/v1/me', headers: bearer(access) })).statusCode).toBe(401);
    expect(rejected.map((r) => r.reason)).toEqual(['user_revoked']);
  });

  it('client assertions: wrong alg, forbidden headers, unknown client, client_id mismatch, future iat and long lifetimes are refused', async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases: [string, Promise<string>, string, Record<string, string>?][] = [
      ['wrong alg', assertion({ header: { alg: 'ES384' } }), 'wrong_alg'],
      [
        'jku header',
        assertion({ header: { jku: 'https://evil.example/jwks' } }),
        'forbidden_header',
      ],
      [
        'unknown client',
        assertion({ claims: { iss: 'svc:nobody', sub: 'svc:nobody' } }),
        'unknown_issuer',
      ],
      ['client_id mismatch', assertion(), 'malformed', { client_id: `svc:${svcB}` }],
      ['future iat', assertion({ claims: { iat: now + 120, exp: now + 150 } }), 'issued_in_future'],
      ['long lifetime', assertion({ claims: { iat: now - 30, exp: now + 50 } }), 'malformed'],
      ['exp too far ahead', assertion({ claims: { iat: now + 20, exp: now + 75 } }), 'malformed'],
    ];
    for (const [name, pending, reason, extra] of cases) {
      rejected.length = 0;
      const reply = await clientCredentials(await pending, extra);
      expect({ name, status: reply.statusCode, reasons: rejected.map((r) => r.reason) }).toEqual({
        name,
        status: 401,
        reasons: [reason],
      });
    }
  });

  it('B2: the replay row lives until exp + skew + 60 s, from the assertion, not the DB clock', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jti = uuidv7();
    const reply = await clientCredentials(
      await assertion({ jti, claims: { iat: now, exp: now + 40 } }),
    );
    expect(reply.statusCode).toBe(200);
    const { rows } = await t().superuser.query<{ expires: number }>(
      `SELECT extract(epoch FROM expires_at)::int AS expires FROM cp.client_assertion_replay WHERE jti_hash = $1`,
      [createHash('sha256').update(`svc:${svcA}\u0000${jti}`).digest()],
    );
    expect(rows[0]?.expires).toBe(now + 40 + 30 + 60);
  });

  it('B3: cleanup never starves a newer abandoned code behind handled ones (batch of 1)', async () => {
    const user = await seedUser();
    const sids: string[] = [];
    for (const ageS of [120, 60]) {
      const { sid } = await seedSession(user.id, { status: 'pending' });
      sids.push(sid);
      await withOrg(cpDb, ORG, (trx) =>
        trx
          .insertInto('cp.authorization_code')
          .values({
            code_hash: tokenHash(newAuthorizationCode()),
            org_id: ORG,
            client_id: CLI_CLIENT_ID,
            redirect_uri: 'http://127.0.0.1:49152/callback',
            code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
            session_id: sid,
            callback_ip: '127.0.0.1',
            expires_at: new Date(Date.now() - ageS * 1000),
            used_at: null,
          })
          .execute(),
      );
    }
    const deps = {
      db: cpDb,
      orgId: ORG,
      writer: createAuditWriter({ db: await writerDb() }),
      policyVersion: policyVersion(config.access),
    };
    // Other tests may have left abandoned codes too; run until these two are handled.
    for (let i = 0; i < 10; i++) {
      if ((await runCleanup(deps, { batch: 1 })).codesNotRedeemed === 0) break;
    }
    for (const sid of sids) {
      expect(await events({ sid, action: 'auth.sign_in' })).toEqual([
        expect.objectContaining({ reason_code: 'code_not_redeemed' }),
      ]);
    }
  });

  // --- cleanup -------------------------------------------------------------------------------
  it('cleanup: an unredeemed code revokes its pending session once (code_not_redeemed); expired rows and old sessions are purged', async () => {
    const user = await seedUser();
    const { sid } = await seedSession(user.id, { status: 'pending' });
    const code = newAuthorizationCode();
    await withOrg(cpDb, ORG, (trx) =>
      trx
        .insertInto('cp.authorization_code')
        .values({
          code_hash: tokenHash(code),
          org_id: ORG,
          client_id: CLI_CLIENT_ID,
          redirect_uri: 'http://127.0.0.1:49152/callback',
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          session_id: sid,
          callback_ip: '127.0.0.1',
          expires_at: new Date(Date.now() - 1_000),
          used_at: null,
        })
        .execute(),
    );
    const old = await seedSession(user.id);
    const replayHash = createHash('sha256').update(uuidv7()).digest();
    await t().superuser.query(
      `UPDATE cp.auth_session SET status = 'revoked', revoked_at = now() - interval '31 days' WHERE id = $1`,
      [old.sid],
    );
    await t().superuser.query(
      `INSERT INTO cp.client_assertion_replay (jti_hash, org_id, expires_at) VALUES ($1, $2, now() - interval '1 second')`,
      [replayHash, ORG],
    );

    const deps = {
      db: cpDb,
      orgId: ORG,
      writer: createAuditWriter({ db: await writerDb() }),
      policyVersion: policyVersion(config.access),
    };
    const first = await runCleanup(deps);
    expect(first).toMatchObject({ codesNotRedeemed: 1, sessions: 1, refreshTokens: 1 });
    expect(first.assertionReplays).toBeGreaterThanOrEqual(1);
    expect((await runCleanup(deps)).codesNotRedeemed).toBe(0);
    expect(await events({ sid, action: 'auth.sign_in' })).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        reason_code: 'code_not_redeemed',
        policy_version: policyVersion(config.access),
      }),
    ]);
    const { rows } = await t().superuser.query<{ id: string; status: string }>(
      `SELECT id, status FROM cp.auth_session WHERE id = ANY($1)`,
      [[sid, old.sid]],
    );
    expect(rows).toEqual([{ id: sid, status: 'revoked' }]);
    // The code's tombstone is deleted one hour after expiry.
    await t().superuser.query(
      `UPDATE cp.authorization_code SET expires_at = now() - interval '61 minutes' WHERE code_hash = $1`,
      [tokenHash(code)],
    );
    expect((await runCleanup(deps)).codes).toBe(1);
  });
});
