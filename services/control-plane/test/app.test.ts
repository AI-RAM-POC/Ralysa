// The serve app without a database (buildApp with a fake key store): health and readiness,
// discovery, problem+json, traceparent, rate limits, route-template logging, org source.
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createRateLimiter } from '../src/http/rate-limits.js';
import { registerRequestContext } from '../src/http/request-context.js';
import { fakeKeys } from './fixtures/fake-keys.js';
import { ORG_ID, TENANT, serveConfig } from './fixtures/serve-config.js';

async function app(options: { ping?: boolean; perIp?: number; global?: number } = {}) {
  const lines: string[] = [];
  const fake = await fakeKeys();
  const instance = await buildApp({
    config: serveConfig(),
    keys: fake.keys,
    pingDatabase: () =>
      options.ping === false ? Promise.reject(new Error('down')) : Promise.resolve(true),
    rateLimiter: createRateLimiter({
      perIpPerMinute: options.perIp ?? 100,
      globalPerMinute: options.global ?? 1000,
    }),
    logStream: { write: (line) => lines.push(line) },
  });
  return { instance, lines, fake };
}

describe('health and readiness', () => {
  it('healthz is ok; readyz is ready with DB, active key and custody', async () => {
    const { instance } = await app();
    expect((await instance.inject('/healthz')).json()).toEqual({ status: 'ok' });
    const ready = await instance.inject('/readyz');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: 'ready',
      checks: { database: true, signing_key: true, custody: true },
    });
  });

  it('readyz is 503 on a DB failure, a custody violation or no active key', async () => {
    const down = await app({ ping: false });
    expect((await down.instance.inject('/readyz')).statusCode).toBe(503);
    const custody = await app();
    custody.fake.state.violation = 'exportable';
    const res = await custody.instance.inject('/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'unready',
      checks: { custody: false, signing_key: false },
    });
    const nokey = await app();
    nokey.fake.state.ready = false;
    expect((await nokey.instance.inject('/readyz')).statusCode).toBe(503);
  });
});

describe('discovery', () => {
  it('RFC 8414 metadata advertises only ES256, S256, public and private_key_jwt clients', async () => {
    const { instance } = await app();
    const body = (await instance.inject('/.well-known/oauth-authorization-server')).json<
      Record<string, unknown>
    >();
    expect(body).toMatchObject({
      issuer: 'https://ralysa.example.qa',
      token_endpoint: 'https://ralysa.example.qa/oauth2/token',
      jwks_uri: 'https://ralysa.example.qa/.well-known/jwks.json',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: ['ES256'],
    });
    expect(body.grant_types_supported).not.toContain('password');
  });

  it('JWKS carries public keys only, with Cache-Control max-age 60 (SEC-F002-33)', async () => {
    const { instance } = await app();
    const res = await instance.inject('/.well-known/jwks.json');
    expect(res.headers['cache-control']).toBe('public, max-age=60, must-revalidate');
    const { keys } = res.json<{ keys: Record<string, unknown>[] }>();
    expect(keys).toHaveLength(1);
    expect(Object.keys(keys[0]!).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
    expect(keys[0]).toMatchObject({ kid: 'ralysa-rts-signing.v1', alg: 'ES256', use: 'sig' });
  });

  it('/v1/auth/config names the enabled flows and the pinned tenant endpoints', async () => {
    const { instance } = await app();
    expect((await instance.inject('/v1/auth/config')).json()).toEqual({
      issuer: 'https://ralysa.example.qa',
      flows: { idp_device: true, loopback_pkce: true },
      idp: {
        kind: 'entra',
        device_authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`,
        token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
        cli_client_id: '4f1c2e3d-0000-4000-8000-0000000000cc',
        scope: 'api://ralysa-rts/Ralysa.SignIn',
      },
      cli_client_id: 'ralysa-cli',
    });
  });
});

describe('cross-cutting behaviour', () => {
  it('continues a valid traceparent and starts a new one otherwise', async () => {
    const { instance } = await app();
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const continued = await instance.inject({
      url: '/healthz',
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });
    expect(continued.headers.traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    const fresh = await instance.inject({ url: '/healthz', headers: { traceparent: 'garbage' } });
    expect(fresh.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    expect(fresh.headers.traceparent).not.toContain(traceId);
  });

  it('unknown routes answer problem+json with a trace id, never echoing the path', async () => {
    const { instance } = await app();
    const res = await instance.inject('/v1/nope?secret=abc');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      type: 'urn:ralysa:problem:not_found',
      status: 404,
      code: 'not_found',
    });
    expect(body.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('rate-limits unauthenticated routes per IP and globally, with Retry-After (SEC-F002-16)', async () => {
    const { instance } = await app({ perIp: 2, global: 3 });
    const hit = (ip: string) => instance.inject({ url: '/v1/auth/config', remoteAddress: ip });
    expect((await hit('10.0.0.1')).statusCode).toBe(200);
    expect((await hit('10.0.0.1')).statusCode).toBe(200);
    const limited = await hit('10.0.0.1');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toMatch(/^\d+$/);
    expect(limited.json()).toMatchObject({ code: 'rate_limited' });
    expect((await hit('10.0.0.2')).statusCode).toBe(200); // per-IP: another client passes
    expect((await hit('10.0.0.3')).statusCode).toBe(429); // global cap reached
    expect((await instance.inject({ url: '/healthz', remoteAddress: '10.0.0.3' })).statusCode).toBe(
      200,
    ); // not limited
  });

  it('an OAuth route is limited with an OAuth error body', async () => {
    const { instance } = await app({ perIp: 1, global: 1000 });
    await instance.inject({ url: '/oauth2/token', method: 'POST', remoteAddress: '10.1.1.1' });
    const limited = await instance.inject({
      url: '/oauth2/token',
      method: 'POST',
      remoteAddress: '10.1.1.1',
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'temporarily_unavailable' });
    expect(limited.headers['cache-control']).toBe('no-store');
  });

  it('logs the route template, status and latency, never the URL, query or headers (SEC-F002-21)', async () => {
    const { instance, lines } = await app();
    await instance.inject({
      url: '/v1/auth/config?code=rly_ac_SECRETSECRETSECRET&state=abc123state',
      headers: { authorization: 'Bearer eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.sig', cookie: 'x=1' },
    });
    const line = lines.find((l) => l.includes('"msg":"request"'));
    expect(line).toBeDefined();
    const record = JSON.parse(line!) as Record<string, unknown>;
    expect(record).toMatchObject({ method: 'GET', route: '/v1/auth/config', status: 200 });
    expect(line).not.toMatch(/SECRET|abc123state|eyJ|Bearer|cookie|\?code/);
  });
});

describe('org source (SEC-F002-31)', () => {
  it('ignores X-Org-Id and any body org_id: unauthenticated routes act in config.org.id', async () => {
    const probe = Fastify();
    registerRequestContext(probe, ORG_ID);
    probe.post('/probe', (request) => ({ org: request.orgId }));
    await probe.ready();
    const res = await probe.inject({
      method: 'POST',
      url: '/probe',
      headers: { 'x-org-id': '00000000-0000-4000-8000-000000000bad' },
      payload: { org_id: '00000000-0000-4000-8000-000000000bad' },
    });
    expect(res.json()).toEqual({ org: ORG_ID });
  });
});
