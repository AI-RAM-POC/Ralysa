// The per-version service key cache behind client_credentials [SEC-F002-22]: a version retired in
// OpenBao (below min_available_version) stops verifying within one cache TTL, and an unknown
// version re-reads the key list at most once per cooldown.
import { createInMemoryKeyCustody } from '@ralysa/secrets';
import { describe, expect, it } from 'vitest';
import {
  SERVICE_KEY_CACHE_TTL_MS,
  SERVICE_KEY_MISS_COOLDOWN_MS,
  createServiceKeyCache,
} from '../src/auth/grants/client-credentials.js';

const KEY = 'ralysa-svc-model-gateway';

async function setup() {
  const custody = createInMemoryKeyCustody();
  await custody.rotate(KEY);
  let reads = 0;
  const counted = {
    ...custody,
    describe: (key: string) => {
      reads++;
      return custody.describe(key);
    },
  };
  let clock = 1_000_000;
  const keyFor = createServiceKeyCache({ custody: counted }, { now: () => clock });
  return {
    custody,
    keyFor,
    reads: () => reads,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('service key cache', () => {
  it('a retired version stops verifying once the cached list is older than the TTL', async () => {
    const { custody, keyFor, advance } = await setup();
    expect(await keyFor(KEY, 1)).toBeDefined();
    await custody.rotate(KEY);
    custody.setMinAvailableVersion(KEY, 2);
    advance(SERVICE_KEY_CACHE_TTL_MS - 1);
    expect(await keyFor(KEY, 1)).toBeDefined(); // still inside the TTL (the documented bound)
    advance(2);
    expect(await keyFor(KEY, 1)).toBeUndefined();
    expect(await keyFor(KEY, 2)).toBeDefined();
  });

  it('an unknown version re-reads the list at most once per cooldown', async () => {
    const { custody, keyFor, reads, advance } = await setup();
    await keyFor(KEY, 1);
    expect(reads()).toBe(1);
    await custody.rotate(KEY);
    for (let i = 0; i < 10; i++) expect(await keyFor(KEY, 2)).toBeUndefined();
    expect(reads()).toBe(1);
    advance(SERVICE_KEY_MISS_COOLDOWN_MS + 1);
    expect(await keyFor(KEY, 2)).toBeDefined();
    expect(reads()).toBe(2);
    expect(await keyFor(KEY, 9)).toBeUndefined(); // a bogus version inside the cooldown
    expect(reads()).toBe(2);
  });
});
