// The in-memory doubles behave like the adapters: versioned secrets with the same watch
// semantics; non-extractable P-256 keys whose ES256 signatures verify against the published JWK
// of their version; flags flipped at runtime are refused by describe (SEC-F002-11).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CustodyViolationError,
  createInMemoryKeyCustody,
  createInMemorySecretStore,
} from '../src/index.js';

interface VerifySubtle {
  importKey(f: 'jwk', k: object, a: object, e: boolean, u: string[]): Promise<object>;
  verify(a: object, k: object, s: Uint8Array, d: Uint8Array): Promise<boolean>;
}
const subtle = (globalThis as unknown as { crypto: { subtle: VerifySubtle } }).crypto.subtle;
const ecdsa = { name: 'ECDSA', hash: 'SHA-256' };
async function verifies(jwk: object, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  const key = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'verify',
  ]);
  return subtle.verify(ecdsa, key, signature, data);
}

describe('in-memory secret store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('versions values and reports changes through watch', async () => {
    const store = createInMemorySecretStore({ 'kv/a': 'one' });
    await expect(store.get('kv/a')).resolves.toEqual({ value: 'one', version: 1 });
    await expect(store.get('kv/missing')).rejects.toMatchObject({ code: 'not_found' });
    const seen: string[] = [];
    const stop = store.watch('kv/a', (v) => seen.push(`${v.value}@${String(v.version)}`), 50);
    await vi.advanceTimersByTimeAsync(60);
    expect(store.put('kv/a', 'two')).toBe(2);
    await vi.advanceTimersByTimeAsync(60);
    stop();
    store.put('kv/a', 'three');
    await vi.advanceTimersByTimeAsync(200);
    expect(seen).toEqual(['two@2']);
  });

  it('can fail reads on demand', async () => {
    const store = createInMemorySecretStore({ 'kv/a': 'one' });
    store.fail('kv/a', new Error('boom'));
    await expect(store.get('kv/a')).rejects.toThrow('boom');
    store.fail('kv/a', undefined);
    await expect(store.get('kv/a')).resolves.toMatchObject({ version: 1 });
  });
});

describe('in-memory key custody', () => {
  it('signs with each version; each signature verifies only against its own version', async () => {
    const custody = createInMemoryKeyCustody();
    await custody.rotate('k');
    await custody.rotate('k');
    const described = await custody.describe('k');
    expect(described).toMatchObject({
      latestVersion: 2,
      exportable: false,
      allowPlaintextBackup: false,
    });
    const data = new Uint8Array([1, 2, 3]);
    const [v1, v2] = described.versions;
    const s1 = await custody.sign('k', 1, data);
    const s2 = await custody.sign('k', 2, data);
    expect(s1).toHaveLength(64);
    expect(await verifies(v1!.jwk, s1, data)).toBe(true);
    expect(await verifies(v2!.jwk, s2, data)).toBe(true);
    expect(await verifies(v2!.jwk, s1, data)).toBe(false);
  });

  it('refuses unknown keys and unavailable versions', async () => {
    const custody = createInMemoryKeyCustody();
    await expect(custody.describe('nope')).rejects.toMatchObject({ code: 'not_found' });
    await custody.rotate('k');
    await custody.rotate('k');
    await expect(custody.sign('k', 3, new Uint8Array())).rejects.toThrow(/unavailable/);
    custody.setMinAvailableVersion('k', 2);
    await expect(custody.sign('k', 1, new Uint8Array())).rejects.toThrow(/unavailable/);
    expect((await custody.describe('k')).versions.map((v) => v.version)).toEqual([2]);
  });

  it.each([{ exportable: true }, { allowPlaintextBackup: true }])(
    'describe refuses the key after %o is flipped at runtime',
    async (flags) => {
      const custody = createInMemoryKeyCustody();
      await custody.rotate('k');
      await expect(custody.describe('k')).resolves.toBeDefined();
      custody.setFlags('k', flags);
      await expect(custody.describe('k')).rejects.toBeInstanceOf(CustodyViolationError);
      custody.setFlags('k', { exportable: false, allowPlaintextBackup: false });
      await expect(custody.describe('k')).resolves.toBeDefined();
    },
  );
});
