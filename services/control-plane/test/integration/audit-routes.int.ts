// F-002-T12 against the dev stack: the three audit routes over the real database roles (the cp app
// role, the insert-only writer, the reader), with tokens minted by the in-memory RTS key (as in
// the T08 and T11 tests) and sessions seeded directly.
//   - TC-F-002-17 (AC-11, AC-13): POST /v1/audit/events — stored with the AC-11 fields, source from
//     the token; 401 / 403 (+ auth.token_rejected); duplicate; the per-service allow-list with
//     audit.ingest_rejected [SEC-F002-03]; I-JSON 422; 503 when the insert can't commit; service
//     auth.token_rejected reports aggregated and stored under the service's source (T11-2).
//   - TC-F-002-18 (AC-12): GET /v1/audit/events — an admin's filtered query, audit.query committed
//     before results [SEC-F002-06 c], 503 when it can't be; a non-admin's 403 + audit.query denied,
//     itself queryable; keyset paging; seals.
//   - TC-F-002-22 (AC-16): POST /v1/audit/client-events — actor overwrite, allow-list, server-issued
//     sessions bound to sid, open-session cap, reserved keys, size, gaps, late events, final_seq,
//     kill-switch scopes, 503 ack=false, the per-user rate limit, and the sweep.
import { uuidv7 } from '@ralysa/protocol/common';
import { CLI_CLIENT_ID } from '@ralysa/protocol/auth';
import { devStackOrSkip } from '@ralysa/dev-stack/harness';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { sweepClientSessions } from '../../src/audit/client-sweep.js';
import { tokenRejectedEvent } from '../../src/audit/events.js';
import { createRejectionAggregator } from '../../src/audit/rejections.js';
import { sealOnce } from '../../src/audit/sealer/sealer.js';
import { type AuditWriter, createAuditWriter } from '../../src/audit/writer.js';
import { createSession } from '../../src/auth/sessions.js';
import { mintAccessToken } from '../../src/auth/tokens/mint.js';
import { createDb, withOrg } from '../../src/db/kysely.js';
import type { Database } from '../../src/db/types.js';
import { createRateLimiter } from '../../src/http/rate-limits.js';
import { ensureOrganization } from '../../src/org/bootstrap.js';
import { fakeKeys } from '../fixtures/fake-keys.js';
import { TENANT, serveConfig } from '../fixtures/serve-config.js';
import { type TestDatabase, createTestDatabase } from './support/db.js';

const stack = await devStackOrSkip();
const service = (name: string, actions: string[]) => ({
  name,
  client_id: `svc:${name}`,
  transit_key: `ralysa-svc-${name}`,
  audit_actions: actions,
});
const config = serveConfig({
  env: 'test',
  org: {
    id: uuidv7(),
    name: 'Org A',
    residency: 'in_country',
    region: 'qa-doha',
    deployment_model: 'on_prem',
  },
  services: [
    service('model-gateway', ['model.call.completed', 'auth.token_rejected']),
    service('mcp-gateway', ['tool.call.completed']),
    // A registered client whose name has no audit source.
    service('t12-odd', ['tool.call.completed']),
  ],
});
const ORG = config.org.id;
const ISSUER = config.public_base_url;
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const nowS = () => Math.floor(Date.now() / 1000);
const HOUR = 60 * 60 * 1000;

describe.skipIf(stack === undefined)('audit endpoints (F-002-T12)', () => {
  let db: TestDatabase | undefined;
  let cpDb: Kysely<Database>;
  let app: FastifyInstance;
  let signing: Awaited<ReturnType<typeof fakeKeys>>;
  let writer: AuditWriter;
  const pending = new Set<Promise<unknown>>();
  /** Waits for the fire-and-forget audit writes (rejections, denials) to land. */
  const settled = async () => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };
  const t = (): TestDatabase => {
    if (db === undefined) throw new Error('beforeAll did not create the database');
    return db;
  };

  // --- tokens and seed data -------------------------------------------------------------------
  const serviceToken = (name: string) =>
    mintAccessToken(signing.keys, {
      iss: ISSUER,
      aud: 'control-plane',
      sub: `svc:${name}`,
      client_id: `svc:${name}`,
      tid: ORG,
      token_use: 'service',
      iat: nowS(),
      nbf: nowS(),
      exp: nowS() + 300,
      jti: uuidv7(),
    });
  const userToken = (user: { id: string; sid: string }) =>
    mintAccessToken(signing.keys, {
      iss: ISSUER,
      aud: 'control-plane',
      sub: user.id,
      client_id: CLI_CLIENT_ID,
      tid: ORG,
      sid: user.sid,
      idp_sub: `oid-${user.id.slice(-8)}`,
      surface: 'cli',
      auth_time: nowS() - 60,
      region: 'qa-doha',
      token_use: 'access',
      iat: nowS(),
      nbf: nowS(),
      exp: nowS() + 900,
      jti: uuidv7(),
    });

  const groupId = async (idpGroupId: string, role: 'access' | 'platform_admin') =>
    withOrg(cpDb, ORG, async (trx) => {
      await trx
        .insertInto('cp.idp_group')
        .values({
          id: uuidv7(),
          org_id: ORG,
          idp_group_id: idpGroupId,
          display_name: role,
          role,
          name_refreshed_at: null,
        })
        .onConflict((oc) => oc.columns(['org_id', 'idp_group_id']).doNothing())
        .execute();
      return (
        await trx
          .selectFrom('cp.idp_group')
          .select('id')
          .where('idp_group_id', '=', idpGroupId)
          .executeTakeFirstOrThrow()
      ).id;
    });

  const seedUser = async (
    options: {
      roles?: ('user' | 'platform_admin')[];
      adminMember?: boolean;
      department?: string;
    } = {},
  ) => {
    const roles = options.roles ?? ['user'];
    const id = uuidv7();
    const access = await groupId(config.access.access_group_id, 'access');
    const admin = await groupId(config.access.admin_group_id, 'platform_admin');
    const sid = await withOrg(cpDb, ORG, async (trx) => {
      await trx
        .insertInto('cp.app_user')
        .values({
          id,
          org_id: ORG,
          idp_issuer: config.idp.issuer,
          idp_tenant_id: TENANT,
          idp_subject: `oid-${id.slice(-8)}`,
          email: null,
          display_name: 'مدقق',
          department_id: options.department ?? null,
          revoked_before: null,
          last_sign_in_at: null,
        })
        .execute();
      const groups = [
        ...(roles.includes('user') ? [access] : []),
        ...((options.adminMember ?? roles.includes('platform_admin')) ? [admin] : []),
      ];
      for (const group of groups) {
        await trx
          .insertInto('cp.group_membership')
          .values({ org_id: ORG, user_id: id, group_id: group, source: 'graph_check' })
          .execute();
      }
      return createSession(trx, {
        orgId: ORG,
        userId: id,
        clientId: CLI_CLIENT_ID,
        surface: 'cli',
        flow: 'loopback_pkce',
        status: 'active',
        roles,
        absoluteSeconds: 3600,
      });
    });
    return { id, sid };
  };

  const newSid = async (userId: string) =>
    withOrg(cpDb, ORG, async (trx) =>
      createSession(trx, {
        orgId: ORG,
        userId,
        clientId: CLI_CLIENT_ID,
        surface: 'cli',
        flow: 'loopback_pkce',
        status: 'active',
        roles: ['user'],
        absoluteSeconds: 3600,
      }),
    );

  type Row = Record<string, unknown> & {
    event_id: string;
    action: string;
    details: Record<string, unknown>;
  };
  const rows = async (where: string, params: unknown[] = []): Promise<Row[]> =>
    (
      await t().superuser.query<Row>(
        `select * from audit.audit_event where org_id = $1 and ${where} order by ingest_seq`,
        [ORG, ...params],
      )
    ).rows;

  const inject = (
    method: 'GET' | 'POST',
    url: string,
    token: string | undefined,
    payload?: unknown,
  ): Promise<LightMyRequestResponse> =>
    app.inject({
      method,
      url,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined
        ? {}
        : { payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
    });

  /**
   * Holds EXCLUSIVE on audit_event (reads pass, inserts wait): the writer's 250 ms bound fails.
   * Before the lock is released, the refused writes are awaited AND the blocked inserts must be
   * gone (cancelled by their statement_timeout), so none can commit late and race the test's
   * assertions (review of #33, R33-5).
   */
  const withAuditLocked = async <T>(fn: () => Promise<T>): Promise<T> => {
    const su = t().superuser;
    await su.query('BEGIN');
    await su.query('LOCK TABLE audit.audit_event IN EXCLUSIVE MODE');
    try {
      return await fn();
    } finally {
      await settled();
      const waiting = async () =>
        (
          await t().superuser.query<{ n: number }>(
            `select count(*)::int as n from pg_locks
              where relation = 'audit.audit_event'::regclass and not granted`,
          )
        ).rows[0]?.n ?? 0;
      for (let i = 0; i < 10_000 && (await waiting()) > 0; i++) {
        // Polls the lock table; the writer's statement_timeout ends each wait within 250 ms.
      }
      await su.query('ROLLBACK');
    }
  };

  // --- setup ----------------------------------------------------------------------------------
  beforeAll(async () => {
    db = await createTestDatabase(stack!);
    await db.migrate(ORG);
    cpDb = createDb<Database>(await db.pool('cp_app', 6));
    await ensureOrganization(cpDb, config);
    signing = await fakeKeys();
    const real = createAuditWriter({ db: createDb<Database>(await db.pool('audit_writer', 4)) });
    const track = <T>(p: Promise<T>): Promise<T> => {
      pending.add(p);
      void p.finally(() => pending.delete(p)).catch(() => undefined);
      return p;
    };
    writer = {
      write: (org, events) => track(real.write(org, events)),
      writeOrSpool: (org, events) => track(real.writeOrSpool(org, events)),
    };
    app = await buildApp({
      config,
      keys: signing.keys,
      rts: {
        db: cpDb,
        custody: signing.custody,
        directory: { check: () => Promise.reject(new Error('not used')) },
        writer,
        auditReader: createDb<Database>(await db.pool('audit_reader', 3)),
        rejections: createRejectionAggregator({
          emit: (r) => void writer.writeOrSpool(ORG, [tokenRejectedEvent(r)]),
        }),
      },
      rateLimiter: createRateLimiter({ perIpPerMinute: 10_000, globalPerMinute: 10_000 }),
      pingDatabase: () => Promise.resolve(true),
    });
  }, 60_000);

  afterAll(async () => {
    await settled();
    await app.close();
    await db?.drop();
  });

  // --- TC-F-002-17 ------------------------------------------------------------------------------
  describe('POST /v1/audit/events (TC-F-002-17)', () => {
    const svcEvent = (userId: string | null, over: Record<string, unknown> = {}) => ({
      event_id: uuidv7(),
      action: 'model.call.completed',
      actor: { type: 'user', user_id: userId, idp_subject: null, service: null },
      resource: { type: 'model_endpoint', id: 'model-a' },
      operation: 'invoke',
      outcome: 'success',
      session_id: 'agent-session-1',
      trace_id: TRACE,
      endpoint_region: 'qa-doha',
      inference_region: 'me-central-1',
      inference_region_source: 'registry_declared',
      tokens_in: 120,
      tokens_out: 45,
      details: { model_id: 'model-a' },
      ...over,
    });

    it('stores an event with the AC-11/AC-13 fields; source from the token, attestation server', async () => {
      const alice = await seedUser();
      const event = svcEvent(alice.id);
      // `source` and `attestation` are not input fields: the strict schema refuses them.
      for (const forged of [{ source: 'control-plane' }, { attestation: 'server' }]) {
        const reply = await inject(
          'POST',
          '/v1/audit/events',
          await serviceToken('model-gateway'),
          { events: [{ ...event, ...forged }] },
        );
        expect(reply.statusCode).toBe(422);
      }
      const reply = await inject('POST', '/v1/audit/events', await serviceToken('model-gateway'), {
        events: [event],
      });
      expect(reply.statusCode).toBe(201);
      expect(reply.json()).toEqual({ results: [{ event_id: event.event_id, status: 'stored' }] });
      const [row] = await rows('event_id = $2', [event.event_id]);
      expect(row).toMatchObject({
        action: 'model.call.completed',
        actor_type: 'user',
        actor_user_id: alice.id,
        resource_type: 'model_endpoint',
        resource_id: 'model-a',
        outcome: 'success',
        trace_id: TRACE,
        session_id: 'agent-session-1',
        endpoint_region: 'qa-doha',
        inference_region: 'me-central-1',
        tokens_in: 120,
        tokens_out: 45,
        source: 'model-gateway',
        attestation: 'server',
        details: { model_id: 'model-a' },
      });
      expect(row?.ts).toBeInstanceOf(Date);
    });

    it('a duplicate event_id is `duplicate` (plain INSERT in a savepoint; the writer has no SELECT)', async () => {
      const alice = await seedUser();
      const event = svcEvent(alice.id);
      const token = await serviceToken('model-gateway');
      await inject('POST', '/v1/audit/events', token, { events: [event] });
      const again = await inject('POST', '/v1/audit/events', token, {
        events: [event, svcEvent(alice.id)],
      });
      expect(again.statusCode).toBe(201);
      expect(again.json<{ results: { status: string }[] }>().results.map((r) => r.status)).toEqual([
        'duplicate',
        'stored',
      ]);
      expect(await rows('event_id = $2', [event.event_id])).toHaveLength(1);
    });

    it('no token → 401; a user token or an unregistered service → 403 and auth.token_rejected', async () => {
      const alice = await seedUser();
      const body = { events: [svcEvent(alice.id)] };
      // Count before the first request: its `malformed` rejection is written fire-and-forget and
      // may already be stored when the next line runs (a CI flake, R34-n8).
      await settled();
      const before = (await rows(`action = 'auth.token_rejected'`)).length;
      expect((await inject('POST', '/v1/audit/events', undefined, body)).statusCode).toBe(401);
      expect(
        (await inject('POST', '/v1/audit/events', await userToken(alice), body)).statusCode,
      ).toBe(403);
      expect(
        (await inject('POST', '/v1/audit/events', await serviceToken('unregistered'), body))
          .statusCode,
      ).toBe(403);
      await settled();
      const rejected = (await rows(`action = 'auth.token_rejected'`)).slice(before);
      // Written fire-and-forget, so compare without order.
      expect(rejected.map((r) => r.reason_code).sort()).toEqual([
        'malformed',
        'wrong_token_use',
        'wrong_token_use',
      ]);
      expect(rejected.every((r) => r.source === 'control-plane')).toBe(true);
    });

    it.each([
      ['auth.sign_in', 'model-gateway'],
      ['audit.query', 'model-gateway'],
      ['db.migration.applied', 'model-gateway'],
      ['model.call.completed', 'mcp-gateway'],
    ])(
      'a service writing %s (%s) → 403 + audit.ingest_rejected; nothing of the batch stored [SEC-F002-03]',
      async (action, name) => {
        const alice = await seedUser();
        const allowed = svcEvent(alice.id, {
          action: name === 'mcp-gateway' ? 'tool.call.completed' : 'model.call.completed',
        });
        const forged = svcEvent(alice.id, { action });
        const reply = await inject('POST', '/v1/audit/events', await serviceToken(name), {
          events: [allowed, forged],
        });
        expect(reply.statusCode).toBe(403);
        expect(await rows('event_id in ($2, $3)', [allowed.event_id, forged.event_id])).toEqual([]);
        const [denial] = await rows(
          `action = 'audit.ingest_rejected' and details->>'action' = $2 and details->>'service' = $3`,
          [action, name],
        );
        expect(denial).toMatchObject({
          outcome: 'denied',
          reason_code: 'action_not_allowed',
          actor_type: 'service',
          actor_service: name,
          source: 'control-plane',
        });
      },
    );

    it('R33-7: a service may not write as another service or as the system', async () => {
      const token = await serviceToken('model-gateway');
      for (const actor of [
        { type: 'service', user_id: null, idp_subject: null, service: 'mcp-gateway' },
        { type: 'system', user_id: null, idp_subject: null, service: 'model-gateway' },
      ]) {
        const reply = await inject('POST', '/v1/audit/events', token, {
          events: [svcEvent(null, { actor })],
        });
        expect([actor.type, reply.statusCode]).toEqual([actor.type, 422]);
      }
      const own = await inject('POST', '/v1/audit/events', token, {
        events: [
          svcEvent(null, {
            actor: { type: 'service', user_id: null, idp_subject: null, service: 'model-gateway' },
          }),
        ],
      });
      expect(own.statusCode).toBe(201);
    });

    it('a registered service without an audit source can write nothing', async () => {
      const alice = await seedUser();
      const reply = await inject('POST', '/v1/audit/events', await serviceToken('t12-odd'), {
        events: [svcEvent(alice.id, { action: 'tool.call.completed' })],
      });
      expect(reply.statusCode).toBe(403);
      expect(
        await rows(`action = 'audit.ingest_rejected' and reason_code = 'no_audit_source'`),
      ).toHaveLength(1);
    });

    it('422: non-I-JSON details, `failure` outside auth.*, an unknown user actor', async () => {
      const alice = await seedUser();
      const token = await serviceToken('model-gateway');
      const event = svcEvent(alice.id);
      const unsafe = JSON.stringify({ events: [event] }).replace(
        '"model_id":"model-a"',
        '"model_id":"model-a","n":9007199254740993',
      );
      expect((await inject('POST', '/v1/audit/events', token, unsafe)).statusCode).toBe(422);
      expect(
        (
          await inject('POST', '/v1/audit/events', token, {
            events: [svcEvent(alice.id, { outcome: 'failure' })],
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (await inject('POST', '/v1/audit/events', token, { events: [svcEvent(uuidv7())] }))
          .statusCode,
      ).toBe(422);
      expect(await rows('event_id = $2', [event.event_id])).toEqual([]);
    });

    it('413 over 256 KB', async () => {
      const token = await serviceToken('model-gateway');
      const big = { events: [svcEvent(null, { details: { pad: 'x'.repeat(300 * 1024) } })] };
      expect((await inject('POST', '/v1/audit/events', token, big)).statusCode).toBe(413);
    });

    it('503 audit_unavailable when the insert cannot commit within 250 ms', async () => {
      const alice = await seedUser();
      const token = await serviceToken('model-gateway');
      const event = svcEvent(alice.id);
      const reply = await withAuditLocked(() =>
        inject('POST', '/v1/audit/events', token, { events: [event] }),
      );
      expect(reply.statusCode).toBe(503);
      expect(reply.json()).toMatchObject({ code: 'audit_unavailable' });
    });

    it('auth.token_rejected reports are aggregated and stored under the reporting service (T11-2)', async () => {
      const token = await serviceToken('model-gateway');
      const report = (n: number) => ({
        event_id: uuidv7(),
        action: 'auth.token_rejected',
        actor: { type: 'user', user_id: null, idp_subject: null, service: null },
        outcome: 'denied',
        reason_code: 'expired',
        trace_id: TRACE,
        details: {
          audience: 'model-gateway',
          reason: 'expired',
          client_ip: n === 0 ? 'not-an-ip' : `198.51.100.${String(n)}`,
        },
      });
      const batch = Array.from({ length: 3 }, (_, i) => report(i));
      const reply = await inject('POST', '/v1/audit/events', token, { events: batch });
      expect(reply.statusCode).toBe(201);
      expect(reply.json<{ results: { status: string }[] }>().results.map((r) => r.status)).toEqual([
        'aggregated',
        'aggregated',
        'aggregated',
      ]);
      const again = await inject('POST', '/v1/audit/events', token, { events: [batch[1]] });
      expect(again.json<{ results: { status: string }[] }>().results[0]?.status).toBe('duplicate');
      await settled();
      const stored = await rows(`action = 'auth.token_rejected' and source = 'model-gateway'`);
      expect(stored).toHaveLength(3);
      // The aggregator's writes run concurrently: compare without order.
      expect(stored.map((r) => r.details.client_network).sort()).toEqual([
        '198.51.100.0/24',
        '198.51.100.0/24',
        'unknown',
      ]);
      // The report's own id is not the stored id (the aggregator writes its own events).
      expect(stored.map((r) => r.event_id)).not.toContain(batch[1]?.event_id);
      // A report with invalid details is refused.
      const bad = { ...report(5), details: { audience: 'nowhere', reason: 'expired' } };
      expect((await inject('POST', '/v1/audit/events', token, { events: [bad] })).statusCode).toBe(
        422,
      );
    });
  });

  // --- TC-F-002-18 ------------------------------------------------------------------------------
  describe('GET /v1/audit/events (TC-F-002-18)', () => {
    const range = () => {
      const now = Date.now();
      return `from=${new Date(now - HOUR).toISOString()}&to=${new Date(now + HOUR).toISOString()}`;
    };
    interface Page {
      events: {
        event_id: string;
        ts: string;
        action: string;
        outcome: string;
        actor: { user_id: string | null };
        seal: unknown;
      }[];
      next_cursor: string | null;
    }

    it('an admin (session role + admin group) queries by user, action, outcome and time; audit.query is committed first', async () => {
      const dana = await seedUser({ roles: ['platform_admin'] });
      const alice = await seedUser();
      const token = await serviceToken('model-gateway');
      const mine = Array.from({ length: 3 }, () => ({
        event_id: uuidv7(),
        action: 'model.call.completed',
        actor: { type: 'user', user_id: alice.id, idp_subject: null, service: null },
        outcome: 'success',
        trace_id: TRACE,
        details: {},
      }));
      expect((await inject('POST', '/v1/audit/events', token, { events: mine })).statusCode).toBe(
        201,
      );
      const danaToken = await userToken(dana);
      const reply = await inject(
        'GET',
        `/v1/audit/events?${range()}&user_id=${alice.id}&action=model.call.completed&outcome=success`,
        danaToken,
      );
      expect(reply.statusCode).toBe(200);
      expect(reply.headers['cache-control']).toBe('no-store');
      const page = reply.json<Page>();
      // Events inserted in the same millisecond order by event_id, not by insertion.
      expect(page.events.map((e) => e.event_id).sort()).toEqual(mine.map((e) => e.event_id).sort());
      expect(page.next_cursor).toBeNull();

      // The query that returns audit.query events sees ITSELF: it was committed before the read.
      const self = await inject(
        'GET',
        `/v1/audit/events?${range()}&action=audit.query&user_id=${dana.id}`,
        danaToken,
      );
      const events = self.json<Page>().events;
      expect(events.length).toBe(2);
      expect(events.every((e) => e.outcome === 'success')).toBe(true);
      const [stored] = await rows(`action = 'audit.query' and actor_user_id = $2`, [dana.id]);
      expect(stored).toMatchObject({
        outcome: 'success',
        policy_version: expect.stringMatching(/^p0-static:[0-9a-f]{12}$/),
        details: {
          filters: {
            user_id: alice.id,
            action: 'model.call.completed',
            outcome: 'success',
            limit: 100,
          },
        },
      });
    });

    it('keyset pages over (ts, event_id) without gaps or repeats; sealed events carry their seal', async () => {
      const dana = await seedUser({ roles: ['platform_admin'] });
      const bob = await seedUser();
      const token = await serviceToken('model-gateway');
      const five = Array.from({ length: 5 }, () => ({
        event_id: uuidv7(),
        action: 'model.call.completed',
        actor: { type: 'user', user_id: bob.id, idp_subject: null, service: null },
        outcome: 'success',
        trace_id: TRACE,
        details: {},
      }));
      await inject('POST', '/v1/audit/events', token, { events: five });
      await sealOnce({ db: createDb<Database>(await t().pool('audit_sealer', 1)), orgId: ORG });
      const danaToken = await userToken(dana);
      const seen: string[] = [];
      const keys: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = `/v1/audit/events?${range()}&user_id=${bob.id}&limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
        const page: Page = (await inject('GET', url, danaToken)).json<Page>();
        seen.push(...page.events.map((e) => e.event_id));
        keys.push(...page.events.map((e) => `${e.ts}|${e.event_id}`));
        for (const e of page.events)
          expect(e.seal).toMatchObject({ shard: 'model-gateway', seq: expect.any(Number) });
        cursor = page.next_cursor;
        pages++;
      } while (cursor !== null);
      expect(pages).toBe(3);
      // No gap and no repeat across pages; within one millisecond the order is by event_id.
      expect(new Set(seen).size).toBe(5);
      expect([...seen].sort()).toEqual(five.map((e) => e.event_id).sort());
      // The pages are in (ts, event_id) order (fixed-width ISO timestamps and UUIDs sort as text).
      expect(keys).toEqual([...keys].sort());
    });

    it('R33-8: a non-admin is refused before parameter validation, and the denial is audited', async () => {
      const bob = await seedUser();
      const reply = await inject('GET', '/v1/audit/events?from=yesterday', await userToken(bob));
      expect(reply.statusCode).toBe(403);
      await settled();
      const [row] = await rows(`action = 'audit.query' and actor_user_id = $2`, [bob.id]);
      expect(row).toMatchObject({
        outcome: 'denied',
        reason_code: 'not_platform_admin',
        details: { filters: { invalid: true } },
      });
    });

    it('a non-admin → 403 with audit.query denied not_platform_admin, and that event is itself queryable', async () => {
      const alice = await seedUser();
      const reply = await inject('GET', `/v1/audit/events?${range()}`, await userToken(alice));
      expect(reply.statusCode).toBe(403);
      await settled();
      const dana = await seedUser({ roles: ['platform_admin'] });
      const page = (
        await inject(
          'GET',
          `/v1/audit/events?${range()}&action=audit.query&user_id=${alice.id}&outcome=denied`,
          await userToken(dana),
        )
      ).json<Page>();
      expect(page.events).toHaveLength(1);
      const [row] = await rows(`action = 'audit.query' and actor_user_id = $2`, [alice.id]);
      expect(row).toMatchObject({ outcome: 'denied', reason_code: 'not_platform_admin' });
    });

    it('the admin role needs a CURRENT admin-group membership, re-read at request time', async () => {
      const erin = await seedUser({ roles: ['platform_admin'], adminMember: false });
      expect(
        (await inject('GET', `/v1/audit/events?${range()}`, await userToken(erin))).statusCode,
      ).toBe(403);
    });

    it('503 when audit.query cannot be committed, and no result is returned', async () => {
      const dana = await seedUser({ roles: ['platform_admin'] });
      const token = await userToken(dana);
      const reply = await withAuditLocked(() =>
        inject('GET', `/v1/audit/events?${range()}`, token),
      );
      expect(reply.statusCode).toBe(503);
      expect(reply.json()).toMatchObject({ code: 'audit_unavailable' });
      expect(reply.json()).not.toHaveProperty('events');
    });

    it('400 for a range over 31 days, a reversed range, a bad limit or cursor', async () => {
      const dana = await seedUser({ roles: ['platform_admin'] });
      const token = await userToken(dana);
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      for (const query of [
        `from=${iso(now - 32 * 24 * HOUR)}&to=${iso(now)}`,
        `from=${iso(now)}&to=${iso(now - HOUR)}`,
        `${range()}&limit=501`,
        `${range()}&cursor=abc`,
        `${range()}&org_id=${uuidv7()}`,
      ]) {
        expect([
          query,
          (await inject('GET', `/v1/audit/events?${query}`, token)).statusCode,
        ]).toEqual([query, 400]);
      }
    });
  });

  // --- TC-F-002-22 ------------------------------------------------------------------------------
  describe('POST /v1/audit/client-events (TC-F-002-22)', () => {
    let seq = 0;
    const cev = (
      clientSeq: number,
      action = 'tool.call.completed',
      over: Record<string, unknown> = {},
    ) => ({
      event_id: uuidv7(),
      client_seq: clientSeq,
      action,
      resource: action.startsWith('tool.') ? { type: 'local_tool', id: 'shell' } : null,
      operation: null,
      outcome: action === 'tool.call.completed' ? 'success' : null,
      reason_code: null,
      tool_call_id: action.startsWith('tool.') ? `tc-${String(++seq)}` : null,
      turn_id: null,
      trace_id: TRACE,
      span_id: null,
      payload_hash: null,
      client: { client_ts: '2026-09-26T10:00:00.000Z' },
      ...over,
    });
    interface ClientReply {
      session_id: string;
      results: {
        event_id: string;
        status: string;
        ack?: { ack: boolean; governance: { halted: boolean } };
      }[];
    }
    const open = async (token: string) => {
      const reply = await inject('POST', '/v1/audit/client-events', token, {
        events: [cev(1, 'session.started')],
      });
      expect(reply.statusCode).toBe(201);
      return reply.json<ClientReply>().session_id;
    };
    const send = (token: string, sessionId: string | undefined, events: unknown[]) =>
      inject('POST', '/v1/audit/client-events', token, {
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
        events,
      });

    it('overwrites actor, org, source, attestation and surface; forged fields stay client data', async () => {
      const alice = await seedUser();
      const mallory = uuidv7();
      const token = await userToken(alice);
      const sessionId = await open(token);
      // An `actor` member is refused by the strict schema…
      expect(
        (await send(token, sessionId, [{ ...cev(2), actor: { type: 'user', user_id: mallory } }]))
          .statusCode,
      ).toBe(422);
      // …and forged identity inside `client` is only ever client data.
      const event = cev(2, 'tool.call.completed', {
        client: { user_id: mallory, org_id: uuidv7(), attestation: 'server', note: 'a‮b' },
      });
      const reply = await send(token, sessionId, [event]);
      expect(reply.statusCode).toBe(201);
      const [row] = await rows('event_id = $2', [event.event_id]);
      expect(row).toMatchObject({
        actor_type: 'user',
        actor_user_id: alice.id,
        actor_idp_subject: `oid-${alice.id.slice(-8)}`,
        org_id: ORG,
        source: 'agent-host-local',
        attestation: 'client',
        surface: 'cli',
        session_id: sessionId,
        client_seq: '2',
        details: { client: { user_id: mallory, attestation: 'server', note: 'ab' } },
      });
    });

    it('422 for a non-allow-listed action or a reserved details key; 413 for an event over 4 KB', async () => {
      const alice = await seedUser();
      const token = await userToken(alice);
      const sessionId = await open(token);
      expect((await send(token, sessionId, [cev(2, 'model.call.completed')])).statusCode).toBe(422);
      for (const client of [
        { server: {} },
        { seq_gap: [1, 2] },
        { nested: { late: true } },
        { reported_by: 'server' },
      ]) {
        expect(
          (await send(token, sessionId, [cev(2, 'tool.call.completed', { client })])).statusCode,
        ).toBe(422);
      }
      expect(
        (
          await send(token, sessionId, [
            cev(2, 'tool.call.completed', { client: { pad: 'x'.repeat(5000) } }),
          ])
        ).statusCode,
      ).toBe(413);
      expect(
        (await send(token, sessionId, [cev(2, 'tool.call.completed', { final_seq: 3 })]))
          .statusCode,
      ).toBe(422);
    });

    it('server-issued sessions: 409 without session.started, for another user or another sid; 20 open per sid', async () => {
      const alice = await seedUser();
      const bob = await seedUser();
      const aliceToken = await userToken(alice);
      expect((await send(aliceToken, undefined, [cev(1)])).statusCode).toBe(409);
      expect((await send(aliceToken, uuidv7(), [cev(1)])).statusCode).toBe(409);
      const sessionId = await open(aliceToken);
      expect((await send(await userToken(bob), sessionId, [cev(2)])).statusCode).toBe(409);
      // The same user after a new sign-in (another sid) can't continue it.
      const again = await userToken({ id: alice.id, sid: await newSid(alice.id) });
      expect((await send(again, sessionId, [cev(2)])).statusCode).toBe(409);
      // session.started only opens a session.
      expect((await send(aliceToken, sessionId, [cev(2, 'session.started')])).statusCode).toBe(409);

      const carol = await seedUser();
      const carolToken = await userToken(carol);
      for (let i = 0; i < 20; i++) await open(carolToken);
      const over = await send(carolToken, undefined, [cev(1, 'session.started')]);
      expect(over.statusCode).toBe(429);
    });

    it('client_seq: a gap is flagged, a late event closes it, a duplicate is detected by event_id, others 409', async () => {
      const alice = await seedUser();
      const token = await userToken(alice);
      const sessionId = await open(token);
      const e5 = cev(5);
      expect((await send(token, sessionId, [e5])).statusCode).toBe(201);
      expect((await rows('event_id = $2', [e5.event_id]))[0]?.details).toMatchObject({
        server: { seq_gap: [2, 4] },
      });
      const e3 = cev(3);
      expect((await send(token, sessionId, [e3])).statusCode).toBe(201);
      expect((await rows('event_id = $2', [e3.event_id]))[0]?.details).toMatchObject({
        server: { late: true },
      });
      // A retry of a stored event is a duplicate, even with a stale seq.
      const retry = await send(token, sessionId, [e3]);
      expect(retry.json<ClientReply>().results).toEqual([
        { event_id: e3.event_id, status: 'duplicate' },
      ]);
      // A new event at a seq that is neither next nor inside an open gap.
      expect((await send(token, sessionId, [cev(3)])).statusCode).toBe(409);
      expect((await send(token, sessionId, [cev(5)])).statusCode).toBe(409);
      // session.ended with final_seq 8: gaps {2, 4} and the tail {7, 8} become final.
      const end = cev(6, 'session.ended', { final_seq: 8 });
      expect((await send(token, sessionId, [end])).statusCode).toBe(201);
      const gaps = await rows(`action = 'audit.client_seq_gap' and session_id = $2`, [sessionId]);
      expect(gaps.map((g) => [g.details.missing_from, g.details.missing_to])).toEqual([
        [2, 2],
        [4, 4],
        [7, 8],
      ]);
      expect(gaps.every((g) => g.outcome === 'error' && g.actor_user_id === alice.id)).toBe(true);
      // The session is closed: nothing new, but a retry of the closing batch is still answered.
      expect((await send(token, sessionId, [cev(7)])).statusCode).toBe(409);
      expect((await send(token, sessionId, [end])).statusCode).toBe(201);
    });

    it('intents are acked with the governance state; a kill-switch (tenant, department, pack) refuses them with 423', async () => {
      const department = uuidv7();
      const alice = await seedUser({ department });
      const token = await userToken(alice);
      const sessionId = await open(token);
      let next = 2;
      const intent = (client: Record<string, unknown> = {}) =>
        cev(next++, 'tool.call.requested', { client: { client_ts: 'x', ...client } });

      const ok = await send(token, sessionId, [intent()]);
      expect(ok.statusCode).toBe(201);
      expect(ok.json<ClientReply>().results[0]?.ack).toMatchObject({
        ack: true,
        governance: { halted: false },
      });

      const su = t().superuser;
      for (const [scope, scopeId, client] of [
        ['tenant', null, {}],
        ['department', department, {}],
        ['pack', 'finance-pack', { pack_id: 'finance-pack' }],
      ] as const) {
        const id = uuidv7();
        await su.query(
          `insert into cp.kill_switch (id, org_id, scope, scope_id, active, reason) values ($1, $2, $3, $4, true, 'test')`,
          [id, ORG, scope, scopeId],
        );
        const event = intent(client);
        const refused = await send(token, sessionId, [event]);
        expect([scope, refused.statusCode]).toEqual([scope, 423]);
        expect(refused.json<ClientReply>().results[0]?.ack).toMatchObject({
          ack: false,
          governance: { halted: true, reason_category: 'kill_switch' },
        });
        const [row] = await rows('event_id = $2', [event.event_id]);
        expect(row).toMatchObject({
          action: 'tool.call.denied',
          outcome: 'denied',
          reason_code: 'kill_switch',
        });
        await su.query(`update cp.kill_switch set active = false where id = $1`, [id]);
      }
      // A pack switch doesn't cover an intent for another pack.
      await su.query(
        `insert into cp.kill_switch (id, org_id, scope, scope_id, active, reason) values ($1, $2, 'pack', 'hr-pack', true, 'test')`,
        [uuidv7(), ORG],
      );
      expect((await send(token, sessionId, [intent({ pack_id: 'finance-pack' })])).statusCode).toBe(
        201,
      );
      await su.query(`update cp.kill_switch set active = false where org_id = $1`, [ORG]);
    });

    it('R33-2: a retry of an intent stored as refused stays refused after the switch is lifted', async () => {
      const alice = await seedUser();
      const token = await userToken(alice);
      const sessionId = await open(token);
      const su = t().superuser;
      const id = uuidv7();
      await su.query(
        `insert into cp.kill_switch (id, org_id, scope, scope_id, active, reason) values ($1, $2, 'tenant', null, true, 'test')`,
        [id, ORG],
      );
      const intent = cev(2, 'tool.call.requested');
      expect((await send(token, sessionId, [intent])).statusCode).toBe(423);
      await su.query(`update cp.kill_switch set active = false where id = $1`, [id]);
      const retry = await send(token, sessionId, [intent]);
      expect(retry.statusCode).toBe(423);
      expect(retry.json<ClientReply>().results[0]).toMatchObject({
        status: 'duplicate',
        ack: { ack: false, governance: { halted: true, reason_category: 'kill_switch' } },
      });
      // A new intent is acked now that the switch is off.
      const next = await send(token, sessionId, [cev(3, 'tool.call.requested')]);
      expect(next.statusCode).toBe(201);
      expect(next.json<ClientReply>().results[0]?.ack).toMatchObject({ ack: true });
    });

    it('503 with ack=false for every intent when the insert fails; nothing stored or advanced', async () => {
      const alice = await seedUser();
      const token = await userToken(alice);
      const sessionId = await open(token);
      const a = cev(2, 'tool.call.requested');
      const b = cev(3, 'tool.call.completed');
      const reply = await withAuditLocked(() => send(token, sessionId, [a, b]));
      expect(reply.statusCode).toBe(503);
      expect(reply.json()).toMatchObject({
        code: 'audit_unavailable',
        acks: [{ event_id: a.event_id, ack: false }],
      });
      expect(await rows('event_id in ($2, $3)', [a.event_id, b.event_id])).toEqual([]);
      // The cursor didn't advance: the same batch goes through afterwards, without a gap.
      const retried = await send(token, sessionId, [a, b]);
      expect(retried.statusCode).toBe(201);
      const [stored] = await rows('event_id = $2', [a.event_id]);
      expect(stored?.details).toMatchObject({ server: { outcome_defaulted: true } });
      expect(stored?.details.server).not.toHaveProperty('seq_gap');
    });

    it('R33-3: stored events whose write committed late still advance the cursor on a retry', async () => {
      const alice = await seedUser();
      const token = await userToken(alice);
      const sessionId = await open(token);
      const e2 = cev(2);
      const e3 = cev(3);
      // As if the batch [e2, e3] had been answered 503 and its insert committed afterwards: the
      // rows exist, the cursor is still at 1.
      const late = [e2, e3].map((e) => ({
        event_id: e.event_id,
        action: e.action,
        actor: {
          type: 'user' as const,
          user_id: alice.id,
          idp_subject: `oid-${alice.id.slice(-8)}`,
          service: null,
        },
        outcome: 'success' as const,
        session_id: sessionId,
        trace_id: TRACE,
        details: { client: {} },
        source: 'agent-host-local' as const,
        attestation: 'client' as const,
        client_seq: e.client_seq,
      }));
      await writer.write(ORG, late);
      // The host retries the batch: duplicates, and the cursor moves to 3.
      const retried = await send(token, sessionId, [e2, e3]);
      expect(retried.statusCode).toBe(201);
      expect(retried.json<ClientReply>().results.map((r) => r.status)).toEqual([
        'duplicate',
        'duplicate',
      ]);
      const e4 = cev(4);
      expect((await send(token, sessionId, [e4])).statusCode).toBe(201);
      expect((await rows('event_id = $2', [e4.event_id]))[0]?.details).not.toHaveProperty(
        'server.seq_gap',
      );
      const end = cev(5, 'session.ended', { final_seq: 5 });
      expect((await send(token, sessionId, [end])).statusCode).toBe(201);
      expect(
        await rows(`action = 'audit.client_seq_gap' and session_id = $2`, [sessionId]),
      ).toEqual([]);
    });

    it('R33-4: a retried opening batch continues the session it already opened', async () => {
      const alice = await seedUser();
      const token = await userToken(alice);
      const started = cev(1, 'session.started');
      const first = await send(token, undefined, [started]);
      expect(first.statusCode).toBe(201);
      const sessionId = first.json<ClientReply>().session_id;
      // The answer was lost; the host sends the same batch again.
      const again = await send(token, undefined, [started, cev(2)]);
      expect(again.statusCode).toBe(201);
      expect(again.json<ClientReply>()).toMatchObject({
        session_id: sessionId,
        results: [{ status: 'duplicate' }, { status: 'stored' }],
      });
      const { rows: cursors } = await t().superuser.query<{ n: number }>(
        `select count(*)::int as n from cp.client_audit_cursor where user_id = $1`,
        [alice.id],
      );
      expect(cursors[0]?.n).toBe(1);
      // N6: the stored session.started records that its outcome was defaulted.
      expect((await rows('event_id = $2', [started.event_id]))[0]?.details).toMatchObject({
        server: { outcome_defaulted: true },
      });
      // Another sign-in (another sid) retrying it gets a new session, not this one.
      const other = await userToken({ id: alice.id, sid: await newSid(alice.id) });
      const elsewhere = await send(other, undefined, [started]);
      expect(elsewhere.json<ClientReply>().session_id).not.toBe(sessionId);
    });

    it('R33-1: a client outcome of failure outside auth.* is 422, not a stuck 500', async () => {
      const alice = await seedUser();
      const token = await userToken(alice);
      const sessionId = await open(token);
      const bad = cev(2, 'tool.call.completed', { outcome: 'failure' });
      expect((await send(token, sessionId, [bad])).statusCode).toBe(422);
      expect((await send(token, sessionId, [cev(2)])).statusCode).toBe(201);
    });

    it('600 events a minute per user, then 429', async () => {
      const alice = await seedUser();
      const token = await userToken(alice);
      const sessionId = await open(token); // 1 event
      let next = 2;
      const batch = (n: number) => Array.from({ length: n }, () => cev(next++));
      for (let i = 0; i < 11; i++)
        expect((await send(token, sessionId, batch(50))).statusCode).toBe(201);
      expect((await send(token, sessionId, batch(49))).statusCode).toBe(201); // 600
      const over = await send(token, sessionId, batch(1));
      expect(over.statusCode).toBe(429);
      expect(over.headers['retry-after']).toMatch(/^\d+$/);
    });

    it('the sweep: gaps idle for 15 min become final; a session idle for 24 h is unterminated and closed', async () => {
      const alice = await seedUser();
      const token = await userToken(alice);
      const idle = await open(token);
      expect((await send(token, idle, [cev(4)])).statusCode).toBe(201);
      const stale = await open(token);
      expect((await send(token, stale, [cev(3)])).statusCode).toBe(201);
      const age = (sessionId: string, interval: string) =>
        t().superuser.query(
          `update cp.client_audit_cursor set updated_at = now() - $2::interval where session_id = $1`,
          [sessionId, interval],
        );
      await age(idle, '16 minutes');
      await age(stale, '25 hours');
      const result = await sweepClientSessions({ db: cpDb, orgId: ORG, writer });
      expect(result).toEqual({ gapsFinalised: 2, unterminated: 1 });
      const idleGap = await rows(`action = 'audit.client_seq_gap' and session_id = $2`, [idle]);
      expect(
        idleGap.map((g) => [g.details.missing_from, g.details.missing_to, g.details.cause]),
      ).toEqual([[2, 3, 'idle']]);
      const [unterminated] = await rows(
        `action = 'audit.client_session_unterminated' and session_id = $2`,
        [stale],
      );
      expect(unterminated).toMatchObject({
        outcome: 'error',
        details: { session_id: stale, last_seq: 3 },
      });
      // A second pass has nothing to do; the unterminated session is closed.
      expect(await sweepClientSessions({ db: cpDb, orgId: ORG, writer })).toEqual({
        gapsFinalised: 0,
        unterminated: 0,
      });
      expect((await send(token, stale, [cev(4)])).statusCode).toBe(409);
      // The idle session still works, but its old gap is closed for good.
      expect((await send(token, idle, [cev(2)])).statusCode).toBe(409);
      expect((await send(token, idle, [cev(5)])).statusCode).toBe(201);
    });
  });
});
