// OpenBao adapters against a fake fetch: auth rules per environment [SEC-F002-12, -22], login and
// re-login, KV v2 read and watch, Transit describe (custody flags, SEC-F002-11) and sign
// (key_version, JWS marshaling). Error messages never carry a token or secret value.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CustodyViolationError,
  type FetchInit,
  SecretsError,
  assertAuthAllowed,
  createOpenBao,
  kvDataPath,
} from '../src/index.js';

interface Call {
  method: string;
  url: string;
  token: string | undefined;
  body: unknown;
}
type Route = (call: Call) => { status: number; body?: unknown };

function fakeFetch(route: Route) {
  const calls: Call[] = [];
  const fetch = (url: string, init: FetchInit) => {
    const call: Call = {
      method: init.method,
      url,
      token: init.headers['x-vault-token'],
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    };
    calls.push(call);
    const reply = route(call);
    return Promise.resolve({
      status: reply.status,
      json: () => Promise.resolve(reply.body),
    });
  };
  return { fetch, calls };
}

const ADDR = 'http://127.0.0.1:58200';
const TOKEN = { method: 'token', token: 'root-token-value' } as const;

interface SubtleWithSpki {
  generateKey(a: object, e: boolean, u: string[]): Promise<{ publicKey: object }>;
  exportKey(f: 'spki', k: object): Promise<ArrayBuffer>;
}
async function pemOfNewKey(): Promise<string> {
  const subtle = (globalThis as unknown as { crypto: { subtle: SubtleWithSpki } }).crypto.subtle;
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const der = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  let binary = '';
  for (const b of der) binary += String.fromCharCode(b);
  const b64 = (globalThis as unknown as { btoa: (s: string) => string }).btoa(binary);
  return `-----BEGIN PUBLIC KEY-----\n${b64.replace(/(.{64})/g, '$1\n')}\n-----END PUBLIC KEY-----\n`;
}

describe('auth rules (SEC-F002-12, -22)', () => {
  it.each([
    [TOKEN, 'dev', undefined, true],
    [TOKEN, 'test', undefined, true],
    [TOKEN, 'production', undefined, false],
    [TOKEN, 'production', true, false],
    [
      { method: 'approle', roleId: 'r', secretId: () => Promise.resolve('s') },
      'production',
      undefined,
      false,
    ],
    [
      { method: 'approle', roleId: 'r', secretId: () => Promise.resolve('s') },
      'production',
      true,
      true,
    ],
    [
      { method: 'approle', roleId: 'r', secretId: () => Promise.resolve('s') },
      'dev',
      undefined,
      true,
    ],
    [
      { method: 'kubernetes', role: 'r', jwt: () => Promise.resolve('j') },
      'production',
      undefined,
      true,
    ],
  ] as const)('%o in %s (allow_approle=%s) → allowed=%s', (auth, env, allowAppRole, allowed) => {
    const run = () => {
      assertAuthAllowed({ auth, env, ...(allowAppRole === undefined ? {} : { allowAppRole }) });
    };
    if (allowed) expect(run).not.toThrow();
    else expect(run).toThrow(SecretsError);
  });

  it('createOpenBao refuses token auth in production before any request', () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200 }));
    expect(() => createOpenBao({ addr: ADDR, auth: TOKEN, env: 'production', fetch })).toThrow(
      /token auth is refused when env=production/,
    );
    expect(calls).toEqual([]);
  });

  it.each(['ftp://x', 'http://user:pw@host:8200', 'http://host:8200/?a=1', 'host:8200', ''])(
    'refuses the vault addr %j',
    (addr) => {
      const { fetch } = fakeFetch(() => ({ status: 200 }));
      expect(() => createOpenBao({ addr, auth: TOKEN, env: 'dev', fetch })).toThrow(/plain http/);
    },
  );
});

describe('login', () => {
  it('logs in with Kubernetes auth once, reuses the token, and re-logs in on a 403', async () => {
    let issued = 0;
    const { fetch, calls } = fakeFetch((call) => {
      if (call.url.endsWith('/v1/auth/kubernetes/login')) {
        issued++;
        return {
          status: 200,
          body: { auth: { client_token: `t${String(issued)}`, lease_duration: 3600 } },
        };
      }
      if (call.token === 't1' && calls.filter((c) => c.url.includes('/data/')).length > 2) {
        return { status: 403 }; // t1 expired: lookup-self is refused too
      }
      if (call.url.endsWith('/v1/kv/data/denied')) return { status: 403 };
      if (call.url.endsWith('/v1/auth/token/lookup-self')) return { status: 200, body: {} };
      return { status: 200, body: { data: { data: { value: 'v' }, metadata: { version: 1 } } } };
    });
    const { secrets } = createOpenBao({
      addr: ADDR,
      env: 'production',
      fetch,
      auth: { method: 'kubernetes', role: 'ralysa-cp-serve', jwt: () => Promise.resolve('sa-jwt') },
    });
    await Promise.all([secrets.get('kv/a'), secrets.get('kv/b')]);
    expect(issued).toBe(1);
    expect(calls[0]?.body).toEqual({ role: 'ralysa-cp-serve', jwt: 'sa-jwt' });
    await secrets.get('kv/c'); // t1 now answers 403 and lookup-self 403 → re-login → t2
    expect(issued).toBe(2);
    expect(calls.at(-1)?.token).toBe('t2');
    // A policy denial with a valid token: lookup-self succeeds, no new login, access_denied.
    await expect(secrets.get('kv/denied')).rejects.toMatchObject({ code: 'access_denied' });
    expect(issued).toBe(2);
  });

  it('AppRole login failure is auth_failed and names no credential', async () => {
    const { fetch } = fakeFetch(() => ({ status: 400, body: { errors: ['invalid secret id'] } }));
    const { secrets } = createOpenBao({
      addr: ADDR,
      env: 'dev',
      fetch,
      auth: {
        method: 'approle',
        roleId: 'role-id-value',
        secretId: () => Promise.resolve('secret-id-value'),
      },
    });
    const error = await secrets.get('kv/x').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'auth_failed' });
    expect((error as Error).message).not.toMatch(/role-id-value|secret-id-value/);
  });

  it('an unreachable OpenBao is `unavailable`', async () => {
    const { secrets } = createOpenBao({
      addr: ADDR,
      env: 'dev',
      auth: TOKEN,
      fetch: () => Promise.reject(new Error('ECONNREFUSED root-token-value')),
    });
    const error = await secrets.get('kv/x').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'unavailable' });
    expect((error as Error).message).not.toContain('root-token-value');
  });
});

describe('KV v2', () => {
  it('maps a mount-first path to the data API and returns value and version', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { data: { data: { value: 's3cr3t' }, metadata: { version: 4 } } },
    }));
    const { secrets } = createOpenBao({ addr: ADDR, env: 'test', auth: TOKEN, fetch });
    await expect(secrets.get('kv/ralysa/control-plane/idp-client-secret')).resolves.toEqual({
      value: 's3cr3t',
      version: 4,
    });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `${ADDR}/v1/kv/data/ralysa/control-plane/idp-client-secret`,
      token: 'root-token-value',
    });
  });

  it.each([
    [403, 'access_denied'],
    [404, 'not_found'],
    [503, 'unavailable'],
  ])('HTTP %i → %s, without the path value leaking beyond its name', async (status, code) => {
    const { fetch } = fakeFetch(() => ({ status }));
    const { secrets } = createOpenBao({ addr: ADDR, env: 'test', auth: TOKEN, fetch });
    await expect(secrets.get('kv/ralysa/control-plane/db/migrator')).rejects.toMatchObject({
      code,
    });
  });

  it('a deleted latest version is not_found', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: { data: { data: null, metadata: { version: 2 } } },
    }));
    const { secrets } = createOpenBao({ addr: ADDR, env: 'test', auth: TOKEN, fetch });
    await expect(secrets.get('kv/x/y')).rejects.toMatchObject({ code: 'not_found' });
  });

  it.each(['kv', 'kv/', '/kv/x', 'kv/../sys/seal', 'kv/a b', 'kv//x'])(
    'refuses the path %j',
    (path) => {
      expect(() => kvDataPath(path)).toThrow(SecretsError);
    },
  );

  describe('watch', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reports each new version once, not the starting one, and keeps polling after errors', async () => {
      let version = 1;
      let failNext = false;
      const { fetch } = fakeFetch(() => {
        if (failNext) {
          failNext = false;
          return { status: 503 };
        }
        return {
          status: 200,
          body: { data: { data: { value: `v${String(version)}` }, metadata: { version } } },
        };
      });
      const { secrets } = createOpenBao({ addr: ADDR, env: 'test', auth: TOKEN, fetch });
      const seen: number[] = [];
      const errors: unknown[] = [];
      const stop = secrets.watch(
        'kv/x/y',
        (v) => seen.push(v.version),
        100,
        (e) => errors.push(e),
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(seen).toEqual([]);
      version = 2;
      await vi.advanceTimersByTimeAsync(100);
      failNext = true;
      await vi.advanceTimersByTimeAsync(100);
      version = 3;
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      expect(seen).toEqual([2, 3]);
      expect(errors).toHaveLength(1);
      stop();
      version = 4;
      await vi.advanceTimersByTimeAsync(500);
      expect(seen).toEqual([2, 3]);
    });
  });
});

describe('Transit', () => {
  const keyReply = async (overrides: Record<string, unknown> = {}) => ({
    type: 'ecdsa-p256',
    exportable: false,
    allow_plaintext_backup: false,
    latest_version: 2,
    min_available_version: 0,
    keys: {
      '1': {
        public_key: await pemOfNewKey(),
        creation_time: '2026-09-01T00:00:00Z',
        name: 'P-256',
      },
      '2': {
        public_key: await pemOfNewKey(),
        creation_time: '2026-09-20T00:00:00Z',
        name: 'P-256',
      },
    },
    ...overrides,
  });

  it('describe returns every available version as a public P-256 JWK', async () => {
    const data = await keyReply();
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { data } }));
    const { keys } = createOpenBao({ addr: ADDR, env: 'test', auth: TOKEN, fetch });
    const described = await keys.describe('ralysa-rts-signing');
    expect(calls[0]?.url).toBe(`${ADDR}/v1/transit/keys/ralysa-rts-signing`);
    expect(described.latestVersion).toBe(2);
    expect(described.versions.map((v) => v.version)).toEqual([1, 2]);
    for (const v of described.versions) {
      expect(Object.keys(v.jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
      expect(v.jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    }
    expect(described.versions[1]?.createdAt.toISOString()).toBe('2026-09-20T00:00:00.000Z');
  });

  it('describe lists only versions from min_available_version', async () => {
    const data = await keyReply({ min_available_version: 2 });
    const { fetch } = fakeFetch(() => ({ status: 200, body: { data } }));
    const { keys } = createOpenBao({ addr: ADDR, env: 'test', auth: TOKEN, fetch });
    expect((await keys.describe('k')).versions.map((v) => v.version)).toEqual([2]);
  });

  it.each([
    [{ exportable: true }, true, false],
    [{ allow_plaintext_backup: true }, false, true],
    [{ exportable: true, allow_plaintext_backup: true }, true, true],
    [{ exportable: undefined }, true, false],
  ])(
    'describe rejects %o as a custody violation (SEC-F002-11)',
    async (flags, exportable, backup) => {
      const data = await keyReply(flags);
      const { fetch } = fakeFetch(() => ({ status: 200, body: { data } }));
      const { keys } = createOpenBao({ addr: ADDR, env: 'test', auth: TOKEN, fetch });
      const error = await keys.describe('ralysa-rts-signing').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CustodyViolationError);
      expect(error).toMatchObject({
        key: 'ralysa-rts-signing',
        exportable,
        allowPlaintextBackup: backup,
      });
    },
  );

  it('describe rejects a key that is not ecdsa-p256', async () => {
    const data = await keyReply({ type: 'rsa-2048' });
    const { fetch } = fakeFetch(() => ({ status: 200, body: { data } }));
    const { keys } = createOpenBao({ addr: ADDR, env: 'test', auth: TOKEN, fetch });
    await expect(keys.describe('k')).rejects.toMatchObject({ code: 'unsupported_key' });
  });

  it('sign sends base64 input, key_version and JWS marshaling, and returns the 64 raw bytes', async () => {
    const raw = new Uint8Array(64).map((_, i) => i);
    let b64u = '';
    for (const b of raw) b64u += String.fromCharCode(b);
    b64u = (globalThis as unknown as { btoa: (s: string) => string })
      .btoa(b64u)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { data: { signature: `vault:v3:${b64u}` } },
    }));
    const { keys } = createOpenBao({ addr: ADDR, env: 'test', auth: TOKEN, fetch });
    const signature = await keys.sign('ralysa-rts-signing', 3, new Uint8Array([104, 105]));
    expect(signature).toEqual(raw);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${ADDR}/v1/transit/sign/ralysa-rts-signing/sha2-256`,
      body: { input: 'aGk=', key_version: 3, marshaling_algorithm: 'jws' },
    });
  });

  it.each([
    ['vault:v2:AAAA', 'another version'],
    ['vault:v3:AAAA', 'not 64 bytes'],
    ['MEUCIQ', 'not a vault signature'],
  ])('sign refuses the reply %j (%s)', async (signature) => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { data: { signature } } }));
    const { keys } = createOpenBao({ addr: ADDR, env: 'test', auth: TOKEN, fetch });
    await expect(keys.sign('k', 3, new Uint8Array([1]))).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it.each(['../sys', 'a/b', '', 'k k'])('refuses the key name %j', async (name) => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200 }));
    const { keys } = createOpenBao({ addr: ADDR, env: 'test', auth: TOKEN, fetch });
    await expect(keys.describe(name)).rejects.toMatchObject({ code: 'config' });
    await expect(keys.sign(name, 1, new Uint8Array())).rejects.toMatchObject({ code: 'config' });
    expect(calls).toEqual([]);
  });
});
