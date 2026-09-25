// POST /v1/auth/sign-in-failures (F-002 design §3.4.1; AC-4; [AR-16]; SEC-F002-16, -30) and the
// pinned discovery document (§3.2.5 step 2 [AR-12]). Hermetic: the app with the recording writer.
import { uuidv7 } from '@ralysa/protocol/common';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createIdpMetadataSource } from '../src/auth/idp/metadata.js';
import {
  IDENTICAL_REPORTS_PER_NETWORK,
  REPORTS_PER_CLIENT_PER_MINUTE,
  createSignInFailureAggregator,
  reportEventId,
} from '../src/auth/routes/sign-in-failures.js';
import { createRateLimiter } from '../src/http/rate-limits.js';
import { fakeKeys } from './fixtures/fake-keys.js';
import { type FakeRts, fakeRts } from './fixtures/fake-rts.js';
import { serveConfig } from './fixtures/serve-config.js';
import type { StoredEventInput } from '../src/audit/columns.js';

const config = serveConfig({ env: 'test' });
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(clock = { t: 1_000_000 }): Promise<{ app: FastifyInstance; rts: FakeRts }> {
  const rts = fakeRts({ now: () => clock.t });
  app = await buildApp({
    config,
    keys: (await fakeKeys()).keys,
    rts,
    rateLimiter: createRateLimiter({ perIpPerMinute: 10_000, globalPerMinute: 10_000 }),
    pingDatabase: () => Promise.resolve(true),
  });
  return { app, rts };
}

const report = (over: Record<string, unknown> = {}) => ({
  attempt_id: uuidv7(),
  flow: 'idp_device',
  error: 'expired_token',
  ...over,
});

const post = (a: FastifyInstance, body: unknown, ip = '198.51.100.7') =>
  a.inject({
    method: 'POST',
    url: '/v1/auth/sign-in-failures',
    payload: body as Record<string, unknown>,
    remoteAddress: ip,
  });

const signIns = (rts: FakeRts) => rts.events.filter((e) => e.action === 'auth.sign_in');

describe('client-reported sign-in failures', () => {
  it('records auth.sign_in failure, attestation client, reported_by client (202)', async () => {
    const { app: a, rts } = await start();
    const body = report({
      error: 'conditional_access_blocked',
      idp_error_code: 'AADSTS53003',
      device_label: `${String.fromCodePoint(0x202e)}لابتوب${String.fromCodePoint(0x200b)}`,
    });
    const reply = await post(a, body);
    expect(reply.statusCode).toBe(202);
    const [event] = signIns(rts);
    expect(event).toMatchObject({
      event_id: reportEventId(config.org.id, body.attempt_id),
      outcome: 'failure',
      reason_code: 'idp_error',
      attestation: 'client',
      actor: { type: 'user', user_id: null, idp_subject: null },
      details: {
        server: {
          reported_by: 'client',
          flow: 'idp_device',
          client_ip: '198.51.100.7',
          attempt_id: body.attempt_id,
        },
        client: {
          error: 'conditional_access_blocked',
          idp_error_code: 'AADSTS53003',
          device_label: 'لابتوب',
        },
      },
    });
  });

  it('maps an expired device code to failure expired', async () => {
    const { app: a, rts } = await start();
    await post(a, report());
    expect(signIns(rts)[0]?.reason_code).toBe('expired');
  });

  it('is idempotent per attempt_id', async () => {
    const { app: a, rts } = await start();
    const body = report();
    expect((await post(a, body)).statusCode).toBe(202);
    expect((await post(a, body)).statusCode).toBe(202);
    expect(signIns(rts)).toHaveLength(1);
  });

  it('refuses an invalid report without an event', async () => {
    const { app: a, rts } = await start();
    for (const body of [
      report({ attempt_id: 'x' }),
      report({ flow: 'loopback_pkce' }),
      report({ error: 'weird' }),
      report({ extra: 1 }),
      report({ device_label: 'x'.repeat(65) }),
    ]) {
      expect((await post(a, body)).statusCode).toBe(400);
    }
    expect(signIns(rts)).toHaveLength(0);
  });

  it('limits one client to 10 reports a minute; a throttled report writes nothing', async () => {
    const clock = { t: 1_000_000 };
    const { app: a, rts } = await start(clock);
    for (let i = 0; i < REPORTS_PER_CLIENT_PER_MINUTE; i++) {
      expect((await post(a, report(), '203.0.113.5')).statusCode).toBe(202);
    }
    const throttled = await post(a, report(), '203.0.113.5');
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers['retry-after']).toBeDefined();
    expect(signIns(rts)).toHaveLength(REPORTS_PER_CLIENT_PER_MINUTE);
    // Another client is unaffected.
    expect((await post(a, report(), '203.0.113.6')).statusCode).toBe(202);
    clock.t += 60_000;
    expect((await post(a, report(), '203.0.113.5')).statusCode).toBe(202);
  });
});

describe('sign-in failure aggregation (SEC-F002-16)', () => {
  const traceId = '0af7651916cd43dd8448eb211c80319c';

  it('aggregates identical failures from one /24 past 10 a minute, with suppressed_count', () => {
    const clock = { t: 0 };
    const events: StoredEventInput[] = [];
    const agg = createSignInFailureAggregator({
      emit: (e) => events.push(...e),
      orgId: config.org.id,
      policyVersion: 'p0-static:test',
      now: () => clock.t,
    });
    for (let i = 0; i < 25; i++) {
      agg.record({ report: report() as never, clientIp: `192.0.2.${String(i + 1)}`, traceId });
    }
    expect(events).toHaveLength(IDENTICAL_REPORTS_PER_NETWORK);
    clock.t += 60_000;
    agg.flush();
    const summary = events.at(-1);
    expect(events).toHaveLength(IDENTICAL_REPORTS_PER_NETWORK + 1);
    expect(summary?.details).toMatchObject({
      server: { suppressed_count: 15, network: '192.0.2.0/24' },
    });
    expect((summary?.details.server as Record<string, unknown>).attempt_id).toBeUndefined();
  });

  it('caps the org at 60 events a minute across networks', () => {
    const clock = { t: 0 };
    const events: StoredEventInput[] = [];
    const agg = createSignInFailureAggregator({
      emit: (e) => events.push(...e),
      orgId: config.org.id,
      policyVersion: 'p0-static:test',
      now: () => clock.t,
    });
    for (let i = 0; i < 100; i++) {
      agg.record({ report: report() as never, clientIp: `10.${String(i)}.0.1`, traceId });
    }
    expect(events).toHaveLength(60);
    clock.t += 60_000;
    agg.flush();
    const suppressed = events
      .slice(60)
      .reduce(
        (n, e) => n + ((e.details.server as { suppressed_count?: number }).suppressed_count ?? 0),
        0,
      );
    expect(suppressed).toBe(40);
  });

  it('aggregates IPv6 per /64', () => {
    const events: StoredEventInput[] = [];
    const agg = createSignInFailureAggregator({
      emit: (e) => events.push(...e),
      orgId: config.org.id,
      policyVersion: 'p0-static:test',
      now: () => 0,
    });
    for (let i = 0; i < 12; i++) {
      agg.record({
        report: report() as never,
        clientIp: `2001:db8:1:2::${String(i + 1)}`,
        traceId,
      });
    }
    expect(events).toHaveLength(IDENTICAL_REPORTS_PER_NETWORK);
  });
});

describe('pinned IdP discovery ([AR-12])', () => {
  const issuer = 'https://login.example/tenant/v2.0';
  const doc = (over: Record<string, unknown> = {}) => ({
    issuer,
    jwks_uri: 'https://login.example/tenant/discovery/v2.0/keys',
    token_endpoint: 'https://login.example/tenant/oauth2/v2.0/token',
    authorization_endpoint: 'https://login.example/tenant/oauth2/v2.0/authorize',
    device_authorization_endpoint: 'https://login.example/tenant/oauth2/v2.0/devicecode',
    ...over,
  });
  const source = (body: unknown, status = 200) => {
    const urls: string[] = [];
    const s = createIdpMetadataSource({
      issuer,
      fetch: ((url: string) => {
        urls.push(url);
        return Promise.resolve(new Response(JSON.stringify(body), { status }));
      }) as typeof fetch,
    });
    return { s, urls };
  };

  it('fetches only <issuer>/.well-known/openid-configuration and caches it', async () => {
    const { s, urls } = source(doc());
    expect((await s.get()).tokenEndpoint).toBe('https://login.example/tenant/oauth2/v2.0/token');
    await s.get();
    expect(urls).toEqual(['https://login.example/tenant/v2.0/.well-known/openid-configuration']);
  });

  it.each([
    ['another issuer', doc({ issuer: 'https://login.example/other/v2.0' })],
    ['keys on another origin', doc({ jwks_uri: 'https://evil.example/keys' })],
    ['a token endpoint on another origin', doc({ token_endpoint: 'https://evil.example/token' })],
    [
      'a device endpoint on another origin',
      doc({ device_authorization_endpoint: 'https://evil.example/dc' }),
    ],
    ['a malformed document', { issuer }],
  ])('refuses %s', async (_name, body) => {
    await expect(source(body).s.get()).rejects.toThrow();
  });

  it('retries after a failed fetch', async () => {
    let fail = true;
    const s = createIdpMetadataSource({
      issuer,
      fetch: () => {
        const answer = fail
          ? new Response('{}', { status: 503 })
          : new Response(JSON.stringify(doc()));
        fail = false;
        return Promise.resolve(answer);
      },
    });
    await expect(s.get()).rejects.toThrow();
    expect((await s.get()).issuer).toBe(issuer);
  });
});
