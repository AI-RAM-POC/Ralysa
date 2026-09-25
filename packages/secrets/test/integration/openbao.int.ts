// F-002-T04 against the dev-stack OpenBao: a Transit signature verifies with jose against the
// published key for two versions; describe refuses a key whose exportable or
// allow_plaintext_backup flag was flipped at runtime [SEC-F002-11]; the KV v2 watch sees a new
// version; the serve AppRole reads only its own paths and signs only with the RTS key.
import { compactVerify, importJWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  devStackOrSkip,
  expectOk,
  roleCredentials,
  rootBao,
  uniqueName,
} from '@ralysa/dev-stack/harness';
import { CustodyViolationError, type KeyCustody, createOpenBao } from '../../src/index.js';
import { toBase64 } from '../../src/platform.js';

const stack = await devStackOrSkip();

// The isomorphic tsconfig declares no platform globals; reach them structurally (as src/ does).
const g = globalThis as unknown as {
  TextEncoder: new () => { encode(s: string): Uint8Array };
  setTimeout: (fn: () => void, ms: number) => unknown;
};
const b64u = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const text = (value: string): Uint8Array => new g.TextEncoder().encode(value);

async function jwsWith(custody: KeyCustody, key: string, version: number): Promise<string> {
  const header = b64u(
    text(JSON.stringify({ alg: 'ES256', typ: 'at+jwt', kid: `${key}-v${String(version)}` })),
  );
  const payload = b64u(text(JSON.stringify({ sub: 'test', v: version })));
  const signature = await custody.sign(key, version, text(`${header}.${payload}`));
  return `${header}.${payload}.${b64u(signature)}`;
}

describe.skipIf(stack === undefined)('OpenBao adapters (F-002-T04)', () => {
  const keys = {
    signing: uniqueName('ralysa-test-t04-sign'),
    exportable: uniqueName('ralysa-test-t04-exp'),
    backup: uniqueName('ralysa-test-t04-bak'),
  };
  const kvPath = uniqueName('ralysa/test-t04/watch');
  const rootAdapters = () =>
    createOpenBao({
      addr: stack!.openbao.addr,
      auth: { method: 'token', token: stack!.openbao.rootToken },
      env: 'test',
    });

  beforeAll(async () => {
    const root = rootBao(stack!);
    for (const key of Object.values(keys)) {
      expectOk(await root('POST', `transit/keys/${key}`, { type: 'ecdsa-p256' }), key);
    }
  });

  afterAll(async () => {
    const root = rootBao(stack!);
    for (const key of Object.values(keys)) {
      await root('POST', `transit/keys/${key}/config`, { deletion_allowed: true });
      await root('DELETE', `transit/keys/${key}`);
    }
    await root('DELETE', `kv/metadata/${kvPath}`);
  });

  it('a Transit signature verifies with jose against the published key, for two versions', async () => {
    const { keys: custody } = rootAdapters();
    const v1 = await jwsWith(custody, keys.signing, 1);
    expectOk(await rootBao(stack!)('POST', `transit/keys/${keys.signing}/rotate`, {}), 'rotate');
    const v2 = await jwsWith(custody, keys.signing, 2);
    const described = await custody.describe(keys.signing);
    expect(described.latestVersion).toBe(2);
    const [k1, k2] = await Promise.all(
      described.versions.map((v) => importJWK({ ...v.jwk, alg: 'ES256' }, 'ES256')),
    );
    await expect(compactVerify(v1, k1!)).resolves.toBeDefined();
    await expect(compactVerify(v2, k2!)).resolves.toBeDefined();
    // The old version still signs (tokens minted before activation stay valid, §3.2.4) …
    await expect(
      compactVerify(await jwsWith(custody, keys.signing, 1), k1!),
    ).resolves.toBeDefined();
    // … and a signature never verifies under the other version's key.
    await expect(compactVerify(v1, k2!)).rejects.toThrow();
  });

  it.each([
    ['exportable', { exportable: true }, { exportable: true, allowPlaintextBackup: false }],
    ['backup', { allow_plaintext_backup: true }, { exportable: false, allowPlaintextBackup: true }],
  ] as const)(
    'describe refuses the %s key once its flag is flipped at runtime',
    async (which, flags, expected) => {
      const { keys: custody } = rootAdapters();
      const key = keys[which];
      await expect(custody.describe(key)).resolves.toMatchObject({ exportable: false });
      expectOk(await rootBao(stack!)('POST', `transit/keys/${key}/config`, flags), 'flip');
      const error = await custody.describe(key).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CustodyViolationError);
      expect(error).toMatchObject({ key, ...expected });
    },
  );

  it('the KV v2 watch reports a new version', async () => {
    const root = rootBao(stack!);
    expectOk(await root('POST', `kv/data/${kvPath}`, { data: { value: 'one' } }), 'v1');
    const { secrets } = rootAdapters();
    await expect(secrets.get(`kv/${kvPath}`)).resolves.toEqual({ value: 'one', version: 1 });
    const seen = new Promise<{ value: string; version: number }>((resolve, reject) => {
      const stop = secrets.watch(
        `kv/${kvPath}`,
        (v) => {
          stop();
          resolve(v);
        },
        100,
        reject,
      );
    });
    await new Promise<void>((r) => g.setTimeout(r, 250));
    expectOk(await root('POST', `kv/data/${kvPath}`, { data: { value: 'two' } }), 'v2');
    await expect(seen).resolves.toEqual({ value: 'two', version: 2 });
  });

  it('the serve AppRole reads its own DB credential only and signs with the RTS key only', async () => {
    const { roleId, secretId } = await roleCredentials(stack!, 'ralysa-cp-serve');
    const { secrets, keys: custody } = createOpenBao({
      addr: stack!.openbao.addr,
      auth: { method: 'approle', roleId, secretId: () => Promise.resolve(secretId) },
      env: 'dev',
    });
    await expect(secrets.get('kv/ralysa/control-plane/db/cp_app')).resolves.toMatchObject({
      version: 1,
    });
    await expect(secrets.get('kv/ralysa/control-plane/db/migrator')).rejects.toMatchObject({
      code: 'access_denied',
    });
    const latest = (await rootAdapters().keys.describe('ralysa-rts-signing')).latestVersion;
    await expect(custody.sign('ralysa-rts-signing', latest, text('x'))).resolves.toHaveLength(64);
    await expect(custody.sign('ralysa-audit-checkpoint', 1, text('x'))).rejects.toMatchObject({
      code: 'access_denied',
    });
  });
});
