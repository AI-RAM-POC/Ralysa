// Flow B's browser legs over HTTP (F-002 design §3.3; SEC-F002-04 b; review of #30, R30-1): the
// production cookie attributes, the per-flow cookie name, the clear on callback, and the
// no-store / no-referrer headers on every redirect. Hermetic: the IdP and the store are fakes.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { BINDING_COOKIE, BINDING_COOKIE_DEV, bindingCookie } from '../src/auth/flow-b.js';
import type { SignInStore } from '../src/auth/sign-in-store.js';
import { fakeKeys } from './fixtures/fake-keys.js';
import { fakeRts } from './fixtures/fake-rts.js';
import { serveConfig } from './fixtures/serve-config.js';

const LOOPBACK = 'http://127.0.0.1:49152/callback';
const CHALLENGE = createHash('sha256').update('v'.repeat(43)).digest('base64url');
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const unused = () => Promise.reject(new Error('not used'));

async function start(config = serveConfig()) {
  const states: string[] = [];
  const store: SignInStore = {
    consumeIdpToken: unused,
    findUser: unused,
    revokeUser: unused,
    revokeSession: unused,
    groupsNeedingNames: unused,
    provision: unused,
    saveAuthRequest: () => Promise.resolve(),
    consumeAuthRequest: (hash) =>
      Promise.resolve(
        hash.equals(createHash('sha256').update('known-state').digest())
          ? {
              stateHash: hash,
              browserBindingHash: Buffer.alloc(32),
              clientRedirectUri: LOOPBACK,
              clientState: 'client-state-0123456789',
              clientCodeChallenge: CHALLENGE,
              authorizeIp: '127.0.0.1',
              idpCodeVerifier: 'x',
              idpNonce: 'y',
              live: false, // expired: redirected back without calling the IdP
            }
          : undefined,
      ),
    createCode: unused,
    redeemCode: unused,
    sessionOwner: unused,
    activateSession: unused,
  };
  app = await buildApp({
    config,
    keys: (await fakeKeys()).keys,
    rts: fakeRts({
      signInStore: store,
      oidc: {
        authorizationUrl: (input) => {
          states.push(input.state);
          return Promise.resolve('https://login.example/authorize?x=1');
        },
        redeem: unused,
      },
    }),
    pingDatabase: () => Promise.resolve(true),
  });
  return { app, states };
}

const authorizeUrl = () =>
  `/oauth2/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: 'ralysa-cli',
    redirect_uri: LOOPBACK,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'client-state-0123456789',
  }).toString()}`;

describe('bindingCookie()', () => {
  it('is __Host- and Secure in production over https, with a per-flow id', () => {
    const a = bindingCookie(serveConfig(), 'state-a');
    const b = bindingCookie(serveConfig(), 'state-b');
    expect(a.secure).toBe(true);
    expect(a.name).toMatch(new RegExp(`^${BINDING_COOKIE}_[A-Za-z0-9_-]{12}$`));
    expect(a.name).not.toBe(b.name);
    expect(bindingCookie(serveConfig(), 'state-a').name).toBe(a.name);
  });

  it('drops __Host- and Secure only outside production on plain http', () => {
    const dev = serveConfig({ env: 'dev', public_base_url: 'http://127.0.0.1:4100' });
    const cookie = bindingCookie(dev, 'state-a');
    expect(cookie.secure).toBe(false);
    expect(cookie.name.startsWith(`${BINDING_COOKIE_DEV}_`)).toBe(true);
    // A test deployment on https keeps the production cookie.
    expect(bindingCookie(serveConfig({ env: 'test' }), 's').secure).toBe(true);
  });
});

describe('flow B browser legs (production cookie attributes)', () => {
  it('authorize sets the full __Host- cookie and redirects with no-store and no-referrer', async () => {
    const { app: a, states } = await start();
    const reply = await a.inject({ url: authorizeUrl() });
    expect(reply.statusCode).toBe(302);
    expect(reply.headers.location).toBe('https://login.example/authorize?x=1');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['referrer-policy']).toBe('no-referrer');
    const name = bindingCookie(serveConfig(), states[0] ?? '').name;
    expect(String(reply.headers['set-cookie'])).toMatch(
      new RegExp(
        `^${name}=[A-Za-z0-9_-]{43}; Max-Age=600; Path=/; HttpOnly; SameSite=Lax; Secure$`,
      ),
    );
  });

  it('the callback clears that flow’s cookie (Max-Age=0) and redirects with no-store and no-referrer', async () => {
    const { app: a } = await start();
    const reply = await a.inject({ url: '/oauth2/idp/callback?state=known-state&code=c' });
    expect(reply.statusCode).toBe(302);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['referrer-policy']).toBe('no-referrer');
    expect(String(reply.headers['set-cookie'])).toBe(
      `${bindingCookie(serveConfig(), 'known-state').name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure`,
    );
    const location = new URL(reply.headers.location as string);
    expect(location.searchParams.get('error')).toBe('invalid_request');
  });

  it('an unknown state clears no cookie (another flow’s survives)', async () => {
    const { app: a } = await start();
    const reply = await a.inject({ url: '/oauth2/idp/callback?state=other&code=c' });
    expect(reply.statusCode).toBe(400);
    expect(reply.headers['set-cookie']).toBeUndefined();
  });
});
