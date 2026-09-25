// The per-version service key cache behind client_credentials [SEC-F002-22]: a version retired in
// OpenBao (below min_available_version) stops verifying within one cache TTL, and an unknown
// version re-reads the key list at most once per cooldown.
import { CustodyViolationError, createInMemoryKeyCustody } from '@ralysa/secrets';
import { describe, expect, it } from 'vitest';
import {
  SERVICE_KEY_CACHE_TTL_MS,
  SERVICE_KEY_MISS_COOLDOWN_MS,
  createServiceKeyCache,
  serviceKeyViolationRecorder,
} from '../src/auth/grants/client-credentials.js';
import type { StoredEventInput } from '../src/audit/columns.js';
import { recordingWriter } from './fixtures/fake-rts.js';
import { serveConfig } from './fixtures/serve-config.js';

const KEY = 'ralysa-svc-model-gateway';

async function setup() {
  const custody = createInMemoryKeyCustody();
  await custody.rotate(KEY);
  let reads = 0;
  const violations: CustodyViolationError[] = [];
  const counted = {
    ...custody,
    describe: (key: string) => {
      reads++;
      return custody.describe(key);
    },
  };
  let clock = 1_000_000;
  const keyFor = createServiceKeyCache(
    {
      custody: counted,
      onCustodyViolation: (error) => {
        violations.push(error);
        return Promise.resolve();
      },
    },
    { now: () => clock },
  );
  return {
    custody,
    violations,
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

  it('a version below min_decryption_version is retired even though Transit still lists it', async () => {
    const { custody, keyFor, advance } = await setup();
    await custody.rotate(KEY);
    custody.setMinDecryptionVersion(KEY, 2);
    advance(SERVICE_KEY_CACHE_TTL_MS + 1);
    expect(await keyFor(KEY, 1)).toBeUndefined();
    expect(await keyFor(KEY, 2)).toBeDefined();
  });

  it('a key that violates custody verifies nothing and is reported', async () => {
    const { custody, keyFor, violations } = await setup();
    custody.setFlags(KEY, { exportable: true });
    expect(await keyFor(KEY, 1)).toBeUndefined();
    expect(violations.map((v) => [v.key, v.exportable, v.allowPlaintextBackup])).toEqual([
      [KEY, true, false],
    ]);
  });

  it('secret.custody_violation is written once per key and flag set', async () => {
    const events: StoredEventInput[] = [];
    const record = serviceKeyViolationRecorder({
      writer: recordingWriter(events),
      config: serveConfig(),
    });
    const exportable = new CustodyViolationError(KEY, {
      exportable: true,
      allowPlaintextBackup: false,
    });
    await record(exportable);
    await record(exportable);
    await record(new CustodyViolationError(KEY, { exportable: true, allowPlaintextBackup: true }));
    expect(events.map((e) => [e.action, e.reason_code, e.details])).toEqual([
      [
        'secret.custody_violation',
        'exportable',
        expect.objectContaining({ key: KEY, purpose: 'service_assertion' }),
      ],
      [
        'secret.custody_violation',
        'exportable_and_plaintext_backup',
        expect.objectContaining({ key: KEY }),
      ],
    ]);
  });
});
