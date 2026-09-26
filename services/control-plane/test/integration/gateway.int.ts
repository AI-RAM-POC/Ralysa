// F-002-T11 against the dev stack: a "fake gateway" built only on @ralysa/auth (design §8.1) talks
// to a real control plane over real HTTP. Its service identity is a client assertion signed
// through the dev stack's ralysa-svc-model-gateway Transit key (the service name must be a real
// audit source, so it can't be a throwaway name; T12); the RTS signing key is the in-memory
// custody (JWKS served from it), as in the T08 tests. Sessions are seeded directly until T10 adds
// sign-in; the IdP directory is a controllable fake.
//   - TC-F-002-10: 20 negative cases against the fake gateway (aud=model-gateway) → 20 rejections,
//     reported by @ralysa/auth's rejection reporter through POST /v1/audit/events (T12, T11-2),
//     aggregated at the control plane and STORED as 20 auth.token_rejected events under the
//     configured org with source model-gateway; a valid token yields user id, org_id and, through
//     PrincipalResolver, groups.
//   - TC-F-002-09 (gateway part): a user disabled at the IdP → refresh sets revoked_before →
//     the gateway rejects the access token after its next feed poll (≤ 60 s), and after exp.
//   - The feed, principals and service token source over real HTTP with a Transit-signed
//     assertion (AR-1, SEC-F002-18 a).
import { generateKeyPair, SignJWT } from 'jose';
import {
  type RejectInfo,
  type RejectionReporter,
  type RevocationFeed,
  createAccessTokenVerifier,
  createPrincipalResolver,
  createRejectionReporter,
  createRevocationFeed,
  createServiceTokenSource,
  createTransitAssertionSigner,
} from '@ralysa/auth';
import { CLI_CLIENT_ID, kidFor } from '@ralysa/protocol/auth';
import { uuidv7 } from '@ralysa/protocol/common';
import { type KeyCustody, createOpenBao } from '@ralysa/secrets';
import { devStackOrSkip } from '@ralysa/dev-stack/harness';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createRejectionAggregator } from '../../src/audit/rejections.js';
import { createAuditWriter } from '../../src/audit/writer.js';
import type { DirectoryCheck, IdpDirectory } from '../../src/auth/directory-port.js';
import { createSession, issueRefreshToken } from '../../src/auth/sessions.js';
import { createDb, withOrg } from '../../src/db/kysely.js';
import type { Database } from '../../src/db/types.js';
import { createRateLimiter } from '../../src/http/rate-limits.js';
import { ensureOrganization } from '../../src/org/bootstrap.js';
import { fakeKeys } from '../fixtures/fake-keys.js';
import { TENANT, serveConfig } from '../fixtures/serve-config.js';
import { type TrackedAuditWriter, trackAuditWriter } from './support/audit-writes.js';
import { type TestDatabase, createTestDatabase } from './support/db.js';

const stack = await devStackOrSkip();
const gw = 'model-gateway';
const config = serveConfig({
  env: 'test',
  org: {
    id: uuidv7(),
    name: 'Org G',
    residency: 'in_country',
    region: 'qa-doha',
    deployment_model: 'on_prem',
  },
  services: [
    {
      name: gw,
      client_id: `svc:${gw}`,
      transit_key: `ralysa-svc-${gw}`,
      audit_actions: ['model.call.completed', 'auth.token_rejected'],
    },
  ],
});
const ORG = config.org.id;
const ISSUER = config.public_base_url;
const utf8 = (text: string) => new TextEncoder().encode(text);
const b64u = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === 'string' ? utf8(bytes) : bytes).toString('base64url');

describe.skipIf(stack === undefined)('fake gateway on @ralysa/auth (F-002-T11)', () => {
  let db: TestDatabase | undefined;
  let cpDb: Kysely<Database>;
  let custody: KeyCustody;
  let app: FastifyInstance;
  let base: string;
  let signing: Awaited<ReturnType<typeof fakeKeys>>;
  let feed: RevocationFeed;
  let directoryAnswer: DirectoryCheck;
  const directory: IdpDirectory = { check: () => Promise.resolve(directoryAnswer) };
  // The control plane's cache clock (its feed caches answers for 1 s); tests step past it.
  let cpOffset = 0;
  // The gateway's verifier clock, to move past a token's exp without sleeping.
  let gwOffset = 0;
  const t = (): TestDatabase => {
    if (db === undefined) throw new Error('beforeAll did not create the database');
    return db;
  };

  // --- the fake gateway ----------------------------------------------------------------------
  const rejected: RejectInfo[] = [];
  let reporter: RejectionReporter;
  // The control plane's fire-and-forget audit writes (the rejection aggregator), awaited in tests
  // until their transactions have ended, not only their promises (#43; support/audit-writes.ts).
  let audit: TrackedAuditWriter | undefined;
  const settled = async () => {
    await audit?.settled();
  };
  let gateway: ReturnType<typeof createAccessTokenVerifier>;
  let principals: ReturnType<typeof createPrincipalResolver>;
  const verify = (token: string) =>
    gateway.verify(`Bearer ${token}`, { clientIp: '203.0.113.9', traceId: 'a'.repeat(32) });

  // --- helpers -------------------------------------------------------------------------------
  const form = (url: string, params: Record<string, string>) =>
    fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  const refresh = async (token: string, audience = 'model-gateway') =>
    form('/oauth2/token', {
      grant_type: 'refresh_token',
      client_id: CLI_CLIENT_ID,
      refresh_token: token,
      audience,
    });
  const tokens = async (token: string, audience = 'model-gateway') => {
    const reply = await refresh(token, audience);
    expect(reply.status).toBe(200);
    return (await reply.json()) as { access_token: string; refresh_token: string };
  };

  const seedUser = async (withAccessGroup = true) => {
    const id = uuidv7();
    await withOrg(cpDb, ORG, async (trx) => {
      await trx
        .insertInto('cp.app_user')
        .values({
          id,
          org_id: ORG,
          idp_issuer: config.idp.issuer,
          idp_tenant_id: TENANT,
          idp_subject: uuidv7(),
          email: null,
          display_name: 'مستخدم البوابة',
          department_id: null,
          revoked_before: null,
          last_sign_in_at: null,
        })
        .execute();
      if (!withAccessGroup) return;
      await trx
        .insertInto('cp.idp_group')
        .values({
          id: uuidv7(),
          org_id: ORG,
          idp_group_id: config.access.access_group_id,
          display_name: 'فريق المالية',
          role: 'access',
          name_refreshed_at: null,
        })
        .onConflict((oc) => oc.columns(['org_id', 'idp_group_id']).doNothing())
        .execute();
      const group = await trx
        .selectFrom('cp.idp_group')
        .select('id')
        .where('idp_group_id', '=', config.access.access_group_id)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('cp.group_membership')
        .values({ org_id: ORG, user_id: id, group_id: group.id, source: 'graph_check' })
        .execute();
    });
    return id;
  };

  const seedSession = async (userId: string) =>
    withOrg(cpDb, ORG, async (trx) => {
      const sid = await createSession(trx, {
        orgId: ORG,
        userId,
        clientId: CLI_CLIENT_ID,
        surface: 'cli',
        flow: 'idp_device',
        status: 'active',
        roles: ['user'],
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

  /** Signs arbitrary header and claims with the REAL RTS signing key (to forge bad claims). */
  const forge = async (header: Record<string, unknown>, claims: Record<string, unknown>) => {
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
    const signature = await signing.custody.sign('ralysa-rts-signing', 1, utf8(input));
    return `${input}.${b64u(signature)}`;
  };
  const rtsHeader = { alg: 'ES256', typ: 'at+jwt', kid: kidFor('ralysa-rts-signing', 1) };
  const claimsFor = (userId: string, sid: string, over: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: ISSUER,
      aud: 'model-gateway',
      sub: userId,
      client_id: CLI_CLIENT_ID,
      tid: ORG,
      sid,
      idp_sub: 'b1e2c3d4-0000-4000-8000-00000000e001',
      surface: 'cli',
      auth_time: now - 60,
      region: 'qa-doha',
      token_use: 'access',
      iat: now,
      nbf: now,
      exp: now + 900,
      jti: uuidv7(),
      ...over,
    };
  };
  const poll = async () => {
    cpOffset += 1_100; // past the control plane's 1 s feed cache
    expect(await feed.pollOnce()).toBe('confirmed');
  };

  // --- setup ---------------------------------------------------------------------------------
  beforeAll(async () => {
    custody = createOpenBao({
      addr: stack!.openbao.addr,
      auth: { method: 'token', token: stack!.openbao.rootToken },
      env: 'test',
    }).keys;
    db = await createTestDatabase(stack!);
    await db.migrate(ORG);
    cpDb = createDb<Database>(await db.pool('cp_app', 6));
    await ensureOrganization(cpDb, config);
    signing = await fakeKeys();
    const writerPool = await t().pool('audit_writer', 2);
    audit = trackAuditWriter(createAuditWriter({ db: createDb<Database>(writerPool) }), writerPool);
    const { writer } = audit;
    app = await buildApp({
      config,
      keys: signing.keys,
      rts: {
        db: cpDb,
        custody,
        directory,
        writer,
        now: () => Date.now() + cpOffset,
        rejections: createRejectionAggregator({ emit: () => undefined, perKeyLimit: 1000 }),
      },
      rateLimiter: createRateLimiter({ perIpPerMinute: 10_000, globalPerMinute: 10_000 }),
      pingDatabase: () => Promise.resolve(true),
    });
    base = await app.listen({ host: '127.0.0.1', port: 0 });

    // The gateway: its own service identity, the feed, principals and the verifier.
    const serviceTokens = createServiceTokenSource({
      tokenEndpoint: `${base}/oauth2/token`,
      assertionAudience: `${ISSUER}/oauth2/token`,
      clientId: `svc:${gw}`,
      signer: createTransitAssertionSigner({ custody, transitKey: `ralysa-svc-${gw}` }),
    });
    feed = createRevocationFeed({ url: `${base}/v1/internal/governance`, serviceTokens });
    principals = createPrincipalResolver({ baseUrl: base, serviceTokens });
    reporter = createRejectionReporter({
      url: `${base}/v1/audit/events`,
      serviceTokens,
      audience: 'model-gateway',
    });
    gateway = createAccessTokenVerifier({
      issuer: ISSUER,
      audience: 'model-gateway',
      jwksUrl: `${base}/.well-known/jwks.json`,
      kidPrefix: config.signing_key,
      revocation: feed,
      orgId: ORG,
      now: () => Date.now() + gwOffset,
      onReject: (r) => {
        rejected.push(r);
        reporter.record(r); // never throws, never waits (SEC-F002-16)
      },
    });
    expect(await feed.start()).toBe('confirmed');
  }, 60_000);

  beforeEach(() => {
    directoryAnswer = {
      kind: 'ok',
      inAccessGroup: true,
      inAdminGroup: false,
      sessionsValidFrom: null,
    };
    gwOffset = 0;
  });

  afterAll(async () => {
    feed.stop();
    await settled();
    await app.close();
    await db?.drop();
  });

  // --- tests ---------------------------------------------------------------------------------
  it('TC-F-002-10: a valid token yields user id, org_id and (through PrincipalResolver) groups', async () => {
    const user = await seedUser();
    const { sid, token } = await seedSession(user);
    const { access_token: access } = await tokens(token);
    const result = await verify(access);
    expect(result).toEqual({
      ok: true,
      principal: expect.objectContaining({
        userId: user,
        orgId: ORG,
        sessionId: sid,
        audience: 'model-gateway',
      }),
    });
    const principal = await principals.resolve(user);
    expect(principal).toMatchObject({
      user_id: user,
      org_id: ORG,
      status: 'active',
      roles: ['user'],
      groups: [{ idp_group_id: config.access.access_group_id, role: 'access' }],
    });
  });

  it('TC-F-002-10: 20 negative cases → 20 rejections, stored as 20 auth.token_rejected events', async () => {
    rejected.length = 0;
    const user = await seedUser();
    const live = await seedSession(user);
    const { access_token: valid } = await tokens(live.token);
    const [h = '', p = '', s = ''] = valid.split('.');
    const now = Math.floor(Date.now() / 1000);

    // Revoked session: sign out, then the gateway's next feed poll.
    const gone = await seedSession(user);
    const goneTokens = await tokens(gone.token);
    expect(
      (await form('/oauth2/revoke', { client_id: CLI_CLIENT_ID, token: goneTokens.refresh_token }))
        .status,
    ).toBe(200);
    // iat before revoked_before: a user disabled at the IdP on a refresh.
    const victim = await seedUser();
    const victimSession = await seedSession(victim);
    const victimTokens = await tokens(victimSession.token);
    directoryAnswer = { kind: 'disabled' };
    expect((await refresh(victimTokens.refresh_token)).status).toBe(400);
    directoryAnswer = {
      kind: 'ok',
      inAccessGroup: true,
      inAdminGroup: false,
      sessionsValidFrom: null,
    };
    await poll();

    // A service token (aud control-plane) presented at the user route.
    const serviceToken = await createServiceTokenSource({
      tokenEndpoint: `${base}/oauth2/token`,
      assertionAudience: `${ISSUER}/oauth2/token`,
      clientId: `svc:${gw}`,
      signer: createTransitAssertionSigner({ custody, transitKey: `ralysa-svc-${gw}` }),
    }).getToken();
    // An Entra-shaped token presented directly (RS256, the IdP's issuer).
    const entra = await generateKeyPair('RS256');
    const entraToken = await new SignJWT({
      ver: '2.0',
      tid: TENANT,
      oid: uuidv7(),
      scp: 'Ralysa.SignIn',
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'entra-kid' })
      .setIssuer(config.idp.issuer)
      .setAudience(config.idp.rts_client_id)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(entra.privateKey);
    const publicJwk = (await signing.keys.jwks()).keys[0];

    const cases: [string, string, string][] = [
      [
        'expired',
        await forge(
          rtsHeader,
          claimsFor(user, live.sid, { iat: now - 1000, nbf: now - 1000, exp: now - 60 }),
        ),
        'expired',
      ],
      [
        'tampered payload',
        `${h}.${b64u(JSON.stringify({ ...claimsFor(user, live.sid), sub: victim }))}.${s}`,
        'bad_signature',
      ],
      [
        'tampered signature',
        `${h}.${p}.${s.startsWith('A') ? 'B' : 'A'}${s.slice(1)}`,
        'bad_signature',
      ],
      [
        'aud control-plane',
        await forge(rtsHeader, claimsFor(user, live.sid, { aud: 'control-plane' })),
        'wrong_audience',
      ],
      [
        'aud agent-host',
        await forge(rtsHeader, claimsFor(user, live.sid, { aud: 'agent-host' })),
        'wrong_audience',
      ],
      [
        'aud mcp-gateway',
        await forge(rtsHeader, claimsFor(user, live.sid, { aud: 'mcp-gateway' })),
        'wrong_audience',
      ],
      [
        'aud workspace-runtime',
        await forge(rtsHeader, claimsFor(user, live.sid, { aud: 'workspace-runtime' })),
        'wrong_audience',
      ],
      [
        'array audience',
        await forge(rtsHeader, claimsFor(user, live.sid, { aud: ['model-gateway'] })),
        'wrong_audience',
      ],
      [
        'unknown issuer',
        await forge(rtsHeader, claimsFor(user, live.sid, { iss: 'https://evil.example' })),
        'unknown_issuer',
      ],
      ['alg none', `${b64u(JSON.stringify({ ...rtsHeader, alg: 'none' }))}.${p}.`, 'malformed'],
      [
        'HS256 keyed with the public JWK',
        await new SignJWT(claimsFor(user, live.sid))
          .setProtectedHeader({ ...rtsHeader, alg: 'HS256' })
          .sign(utf8(JSON.stringify(publicJwk))),
        'wrong_alg',
      ],
      [
        'missing kid',
        await forge({ alg: 'ES256', typ: 'at+jwt' }, claimsFor(user, live.sid)),
        'unknown_kid',
      ],
      [
        'unknown kid',
        await forge(
          { ...rtsHeader, kid: kidFor('ralysa-rts-signing', 7) },
          claimsFor(user, live.sid),
        ),
        'unknown_kid',
      ],
      [
        'typ JWT',
        await forge({ ...rtsHeader, typ: 'JWT' }, claimsFor(user, live.sid)),
        'wrong_typ',
      ],
      [
        'nbf in the future',
        await forge(rtsHeader, claimsFor(user, live.sid, { nbf: now + 300 })),
        'not_yet_valid',
      ],
      ['revoked sid', goneTokens.access_token, 'session_revoked'],
      ['iat before revoked_before', victimTokens.access_token, 'user_revoked'],
      ['a service token at a user route', serviceToken, 'wrong_audience'],
      ['an Entra token presented directly', entraToken, 'wrong_alg'],
      ['a refresh token presented as a bearer', live.token, 'malformed'],
    ];
    expect(cases).toHaveLength(20);
    for (const [name, token, reason] of cases) {
      const result = await verify(token);
      expect([name, result]).toEqual([name, { ok: false, reason }]);
    }
    expect(rejected).toHaveLength(20);
    expect(rejected.every((r) => r.clientIp === '203.0.113.9')).toBe(true);

    // The gateway's reporter sends them through the service path; the control plane aggregates
    // them per /24, reason and audience and stores them under its org and the gateway's source.
    expect(reporter.status()).toEqual({ queued: 20, dropped: 0 });
    await reporter.flush();
    expect(reporter.status()).toEqual({ queued: 0, dropped: 0 });
    await settled();
    const { rows: stored } = await t().superuser.query<{
      org_id: string;
      source: string;
      outcome: string;
      reason_code: string;
      trace_id: string;
      details: Record<string, unknown>;
    }>(
      `select org_id, source, outcome, reason_code, trace_id, details from audit.audit_event
        where action = 'auth.token_rejected' and source = 'model-gateway'`,
    );
    expect(stored).toHaveLength(20);
    expect(stored.map((r) => r.reason_code).sort()).toEqual(cases.map((c) => c[2]).sort());
    for (const row of stored) {
      expect(row).toMatchObject({
        org_id: ORG, // the service token's org, pinned to config; never the rejected token's tid
        outcome: 'denied',
        trace_id: 'a'.repeat(32),
        details: {
          audience: 'model-gateway',
          client_ip: '203.0.113.9',
          client_network: '203.0.113.0/24',
        },
      });
      expect(row.details).not.toHaveProperty('suppressed_count');
    }
    // No token of any kind is in what was stored.
    expect(JSON.stringify(stored)).not.toMatch(/eyJ|rly_rt_/);
    // The live session is untouched by all of this.
    expect((await verify(valid)).ok).toBe(true);
  });

  it('TC-F-002-09 (gateway part): a user disabled at the IdP is refused after the next feed poll, and after exp', async () => {
    const carol = await seedUser();
    const session = await seedSession(carol);
    const first = await tokens(session.token);
    expect((await verify(first.access_token)).ok).toBe(true);

    directoryAnswer = { kind: 'disabled' };
    const refused = await refresh(first.refresh_token);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ ralysa_error: { code: 'user_disabled' } });
    // Before the gateway polls, it still holds the old view; within one poll (≤ 5 s ≪ 60 s) it refuses.
    await poll();
    expect(await verify(first.access_token)).toEqual({ ok: false, reason: 'user_revoked' });
    expect(feed.status()).toMatchObject({ stale: false });

    // And any access token dies at exp (+ the 30 s skew) regardless of revocation.
    directoryAnswer = {
      kind: 'ok',
      inAccessGroup: true,
      inAdminGroup: false,
      sessionsValidFrom: null,
    };
    const dora = await seedUser();
    const doraTokens = await tokens((await seedSession(dora)).token);
    expect((await verify(doraTokens.access_token)).ok).toBe(true);
    gwOffset = (config.tokens.access_ttl_s + 31) * 1000;
    expect(await verify(doraTokens.access_token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('the feed is confirmation-checked over real HTTP: epoch never goes back, issued_at is the DB clock', async () => {
    const before = feed.status();
    await poll();
    const after = feed.status();
    expect(after.stale).toBe(false);
    expect(after.epoch).toBeGreaterThanOrEqual(before.epoch ?? 0);
    expect(after.confirmedAt).toBeGreaterThan(before.confirmedAt ?? 0);
  });
});
