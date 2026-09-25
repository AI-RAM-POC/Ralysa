// The token manager: single flight, the one refresher per device [SEC-F002-17], refresh-token
// rotation, and what happens on each RTS answer (§3.2.3, §5.3; the #26 R26-10 contract).
import type { AuthConfig } from '@ralysa/protocol/control-plane';
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';
import {
  ResponseLostError,
  SessionRevokedError,
  TemporarilyUnavailableError,
  type TokenStore,
  createTokenManager,
} from '../src/index.js';
import { ISSUER, clock, fakeFetch } from './support.js';

const cfg: AuthConfig = {
  issuer: ISSUER,
  flows: { idp_device: true, loopback_pkce: true },
  idp: {
    kind: 'entra',
    device_authorization_endpoint: 'https://login.microsoftonline.com/t/oauth2/v2.0/devicecode',
    token_endpoint: 'https://login.microsoftonline.com/t/oauth2/v2.0/token',
    cli_client_id: 'cli',
    scope: 'api://ralysa-rts/Ralysa.SignIn',
  },
  cli_client_id: 'ralysa-cli',
};
const TOKEN = `${ISSUER}/oauth2/token`;
const REVOKE = `${ISSUER}/oauth2/revoke`;
const rt = (n: number) => `rly_rt_${String(n).padStart(43, '0')}`;

function memoryStore(initial: string | null = rt(0)) {
  let value = initial;
  const writes: (string | null)[] = [];
  const store: TokenStore = {
    load: () => Promise.resolve(value),
    save: (v) => {
      value = v;
      writes.push(v);
      return Promise.resolve();
    },
    clear: () => {
      value = null;
      writes.push(null);
      return Promise.resolve();
    },
  };
  return { store, writes, value: () => value };
}

/** A fake RTS that rotates like the real one: a presented token must be the latest. */
function fakeRts(options: { gate?: Promise<void>; ttl?: number } = {}) {
  let latest = 0;
  let mode: 'ok' | 'unavailable' | 'revoked' = 'ok';
  const fetch = fakeFetch({
    [`POST ${TOKEN}`]: async (r) => {
      await options.gate;
      if (mode === 'unavailable')
        return { status: 503, body: { error: 'temporarily_unavailable' } };
      if (mode === 'revoked' || r.form.refresh_token !== rt(latest)) {
        return {
          status: 400,
          body: {
            error: 'invalid_grant',
            ralysa_error: { code: 'reuse_detected', i18n_key: 'auth.denied.reuse_detected' },
          },
        };
      }
      latest++;
      return {
        status: 200,
        body: {
          access_token: `at-${r.form.audience ?? ''}-${String(latest)}`,
          token_type: 'Bearer',
          expires_in: options.ttl ?? 900,
          refresh_token: rt(latest),
        },
      };
    },
    [`POST ${REVOKE}`]: () =>
      mode === 'unavailable' ? { status: 503 } : { status: 200, body: {} },
  });
  return {
    fetch,
    setMode: (m: typeof mode) => {
      mode = m;
    },
  };
}

describe('createTokenManager', () => {
  it('concurrent callers for one audience share one refresh (single flight)', async () => {
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const rts = fakeRts({ gate });
    const s = memoryStore();
    const m = createTokenManager({ cfg, store: s.store, fetch: rts.fetch });
    const all = Promise.all(Array.from({ length: 10 }, () => m.getAccessToken()));
    open();
    expect(new Set(await all)).toEqual(new Set(['at-control-plane-1']));
    expect(rts.fetch.calls(`POST ${TOKEN}`)).toHaveLength(1);
    expect(s.value()).toBe(rt(1));
  });

  it('refreshes for different audiences one after the other, always with the latest rotated token', async () => {
    const rts = fakeRts();
    const s = memoryStore();
    const m = createTokenManager({ cfg, store: s.store, fetch: rts.fetch });
    const [a, b, c] = await Promise.all([
      m.getAccessToken('control-plane'),
      m.getAccessToken('model-gateway'),
      m.getAccessToken('agent-host'),
    ]);
    expect([a, b, c]).toEqual(['at-control-plane-1', 'at-model-gateway-2', 'at-agent-host-3']);
    expect(rts.fetch.calls(`POST ${TOKEN}`).map((r) => r.form.refresh_token)).toEqual([
      rt(0),
      rt(1),
      rt(2),
    ]);
    expect(s.writes).toEqual([rt(1), rt(2), rt(3)]);
  });

  it('reuses a cached access token until 60 s before it expires', async () => {
    const c = clock();
    const rts = fakeRts();
    const m = createTokenManager({ cfg, store: memoryStore().store, fetch: rts.fetch, now: c.now });
    expect(await m.getAccessToken()).toBe('at-control-plane-1');
    c.advance(839_000);
    expect(await m.getAccessToken()).toBe('at-control-plane-1');
    c.advance(1_000);
    expect(await m.getAccessToken()).toBe('at-control-plane-2');
  });

  it('invalid_grant (revoked, reuse): SessionRevokedError and the stored token is cleared', async () => {
    const rts = fakeRts();
    rts.setMode('revoked');
    const s = memoryStore();
    const m = createTokenManager({ cfg, store: s.store, fetch: rts.fetch });
    await expect(m.getAccessToken()).rejects.toMatchObject({
      name: 'SessionRevokedError',
      i18nKey: 'auth.denied.reuse_detected',
      reason: 'reuse_detected',
    });
    expect(s.value()).toBeNull();
    expect(await m.hasSession()).toBe(false);
    await expect(m.getAccessToken()).rejects.toBeInstanceOf(SessionRevokedError);
    expect(rts.fetch.calls(`POST ${TOKEN}`)).toHaveLength(1);
  });

  it('temporarily_unavailable keeps the refresh token, and a later retry succeeds', async () => {
    const rts = fakeRts();
    const s = memoryStore();
    const m = createTokenManager({ cfg, store: s.store, fetch: rts.fetch });
    rts.setMode('unavailable');
    await expect(m.getAccessToken()).rejects.toBeInstanceOf(TemporarilyUnavailableError);
    expect(s.value()).toBe(rt(0));
    rts.setMode('ok');
    expect(await m.getAccessToken()).toBe('at-control-plane-1');
  });

  it('a lost refresh answer (RTS rotated, the response never arrived) → ResponseLostError; the retry is reuse → SessionRevokedError, store cleared', async () => {
    const rts = fakeRts();
    let dropNext = false;
    const lossy = Object.assign(async (url: string, init: Parameters<typeof rts.fetch>[1]) => {
      const reply = await rts.fetch(url, init); // RTS processes (and rotates)…
      if (dropNext) {
        dropNext = false;
        throw new Error('socket hang up'); // …but the answer is lost.
      }
      return reply;
    }, {});
    const s = memoryStore();
    const m = createTokenManager({ cfg, store: s.store, fetch: lossy });
    dropNext = true;
    const lost = await m.getAccessToken().catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(ResponseLostError);
    expect(lost).toBeInstanceOf(TemporarilyUnavailableError);
    expect((lost as ResponseLostError).lostResponse).toBe(true);
    expect(s.value()).toBe(rt(0)); // the old token is still all this client has
    await expect(m.getAccessToken()).rejects.toMatchObject({
      name: 'SessionRevokedError',
      reason: 'reuse_detected',
    });
    expect(s.value()).toBeNull();
    expect(await m.hasSession()).toBe(false);
    // A refusal that DID arrive is not a lost response.
    rts.setMode('unavailable');
    const refused = await createTokenManager({ cfg, store: memoryStore().store, fetch: rts.fetch })
      .getAccessToken()
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TemporarilyUnavailableError);
    expect((refused as TemporarilyUnavailableError).lostResponse).toBe(false);
  });

  it('two managers over one store (a second refresher) end in reuse: the documented defect', async () => {
    const rts = fakeRts();
    const s = memoryStore();
    const first = createTokenManager({ cfg, store: s.store, fetch: rts.fetch });
    const second = createTokenManager({ cfg, store: s.store, fetch: rts.fetch });
    await second.hasSession(); // loads rt(0) into memory before the first one rotates it
    await first.getAccessToken();
    await expect(second.getAccessToken()).rejects.toBeInstanceOf(SessionRevokedError);
  });

  it('signedIn stores a fresh sign-in; signOut revokes at RTS, then forgets', async () => {
    const rts = fakeRts();
    const s = memoryStore(null);
    const m = createTokenManager({ cfg, store: s.store, fetch: rts.fetch });
    expect(await m.hasSession()).toBe(false);
    await m.signedIn({
      accessToken: 'at-signin',
      audience: 'control-plane',
      expiresAt: Date.now() + 900_000,
      refreshToken: rt(0),
    });
    expect(await m.getAccessToken()).toBe('at-signin');
    expect(s.value()).toBe(rt(0));

    rts.setMode('unavailable');
    await expect(m.signOut()).rejects.toBeInstanceOf(TemporarilyUnavailableError);
    expect(s.value()).toBe(rt(0));
    rts.setMode('ok');
    await m.signOut();
    expect(rts.fetch.calls(`POST ${REVOKE}`).at(-1)?.form.token).toBe(rt(0));
    expect(s.value()).toBeNull();
    await expect(m.getAccessToken()).rejects.toBeInstanceOf(SessionRevokedError);

    const local = createTokenManager({ cfg, store: memoryStore().store, fetch: rts.fetch });
    const before = rts.fetch.calls(`POST ${REVOKE}`).length;
    await local.signOut({ localOnly: true });
    expect(rts.fetch.calls(`POST ${REVOKE}`)).toHaveLength(before);
  });
});

describe('package surface', () => {
  it('exports no file-backed TokenStore (design §3.6)', () => {
    expect(Object.keys(api).filter((name) => /file|fs|disk/i.test(name))).toEqual([]);
    expect(Object.keys(api).filter((name) => /store/i.test(name))).toEqual([]);
  });
});
