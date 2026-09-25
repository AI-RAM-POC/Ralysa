// Checkpoint signer and custody monitor (§4.7, §3.2.4; SEC-F002-11) with the in-memory custody,
// the per-entry-point configs for the sealer and audit-verify, and the checkpoint log parser.
import { webcrypto } from 'node:crypto';
import { checkpointPayload } from '@ralysa/protocol/audit';
import { createInMemoryKeyCustody } from '@ralysa/secrets';
import { describe, expect, it } from 'vitest';
import type { StoredEventInput } from '../src/audit/columns.js';
import { createCheckpointSigner } from '../src/audit/sealer/checkpoint.js';
import { parseCheckpointLog } from '../src/audit/verify/audit-verify.js';
import type { AuditWriter } from '../src/audit/writer.js';
import { parseConfig } from '../src/config/load.js';
import { AuditVerifyConfig, SealerConfig } from '../src/config/schema.js';
import { silentLogger } from '../src/observability/logger.js';

const ORG = '0192f0a0-7b3c-7d4e-8f00-00000000000f';

function recordingWriter() {
  const events: StoredEventInput[] = [];
  const writer: AuditWriter = {
    write: (_org, e) => {
      events.push(...e);
      return Promise.resolve(e.map((x) => ({ event_id: x.event_id, status: 'stored' as const })));
    },
    writeOrSpool: (_org, e) => {
      events.push(...e);
      return Promise.resolve({ results: [] });
    },
  };
  return { writer, events };
}

describe('checkpoint signer and custody monitor', () => {
  it('signs with the latest version; the signature verifies over the checkpoint payload', async () => {
    const custody = createInMemoryKeyCustody();
    await custody.rotate('ralysa-audit-checkpoint');
    await custody.rotate('ralysa-audit-checkpoint');
    const { writer } = recordingWriter();
    const signer = createCheckpointSigner({ custody, orgId: ORG, writer, logger: silentLogger });
    expect(signer.healthy()).toBe(false); // not polled yet: never sign blind
    await expect(signer.poll()).resolves.toBe(true);
    const payload = checkpointPayload({
      org_id: ORG,
      shard: 'control-plane',
      seq: 3,
      hash: 'a'.repeat(64),
      checkpoint_ts: '2026-09-25T10:00:00.000Z',
    });
    const { keyVersion, signature } = await signer.sign(payload);
    expect(keyVersion).toBe(2);
    const jwk = (await custody.describe('ralysa-audit-checkpoint')).versions[1]!.jwk;
    const key = await webcrypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    await expect(
      webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, payload),
    ).resolves.toBe(true);
  });

  it.each([
    [{ exportable: true }, 'exportable'],
    [{ allowPlaintextBackup: true }, 'allow_plaintext_backup'],
  ] as const)(
    'a runtime flip of %o stops signing and writes ONE secret.custody_violation',
    async (flags, flag) => {
      const custody = createInMemoryKeyCustody();
      await custody.rotate('ralysa-audit-checkpoint');
      const { writer, events } = recordingWriter();
      const signer = createCheckpointSigner({ custody, orgId: ORG, writer, logger: silentLogger });
      await signer.poll();
      custody.setFlags('ralysa-audit-checkpoint', flags);
      await expect(signer.poll()).resolves.toBe(false);
      await expect(signer.poll()).resolves.toBe(false);
      expect(signer.healthy()).toBe(false);
      await expect(signer.sign(new Uint8Array([1]))).rejects.toThrow(/custody/);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'secret.custody_violation',
        outcome: 'error',
        actor: { type: 'system', service: 'sealer' },
        details: { key: 'ralysa-audit-checkpoint', flag },
      });
      // Restored: signing resumes.
      custody.setFlags('ralysa-audit-checkpoint', {
        exportable: false,
        allowPlaintextBackup: false,
      });
      await expect(signer.poll()).resolves.toBe(true);
      expect(signer.healthy()).toBe(true);
    },
  );
});

describe('sealer and audit-verify configs (SEC-F002-02)', () => {
  const common = {
    org: {
      id: ORG,
      name: 'Org',
      residency: 'in_country',
      region: 'qa-doha',
      deployment_model: 'on_prem',
    },
    vault: { addr: 'https://bao:8200', auth: { method: 'kubernetes', role: 'ralysa-cp-sealer' } },
    db: { host: 'db', port: 5432, database: 'ralysa', ssl: true },
    checkpoint_key: 'ralysa-audit-checkpoint',
  };
  const kv = (key: string) => `kv/ralysa/control-plane/db/${key}`;

  it('the sealer names its own credential and the insert-only writer, nothing else', () => {
    const config = parseConfig(SealerConfig, {
      ...common,
      db_credentials: { audit_sealer: kv('audit_sealer'), audit_writer: kv('audit_writer') },
    });
    expect(config).toMatchObject({
      checkpoint_interval_s: 60,
      custody_poll_s: 30,
      interval_ms: 1000,
    });
    expect(() =>
      parseConfig(SealerConfig, {
        ...common,
        db_credentials: {
          audit_sealer: kv('audit_sealer'),
          audit_writer: kv('audit_writer'),
          migrator: kv('migrator'),
        },
      }),
    ).toThrow(/Unrecognized key/);
    expect(() =>
      parseConfig(SealerConfig, {
        ...common,
        checkpoint_key: 'ralysa-rts-signing',
        db_credentials: { audit_sealer: kv('audit_sealer'), audit_writer: kv('audit_writer') },
      }),
    ).toThrow();
  });

  it('audit-verify is read-only: the reader credential only', () => {
    expect(
      parseConfig(AuditVerifyConfig, {
        ...common,
        db_credentials: { audit_reader: kv('audit_reader') },
      }).db_credentials,
    ).toEqual({
      audit_reader: kv('audit_reader'),
    });
    expect(() =>
      parseConfig(AuditVerifyConfig, {
        ...common,
        db_credentials: { audit_reader: kv('audit_reader'), audit_writer: kv('audit_writer') },
      }),
    ).toThrow(/Unrecognized key/);
  });
});

describe('parseCheckpointLog', () => {
  it('keeps well-formed audit_checkpoint lines only', () => {
    const record = {
      org_id: ORG,
      shard: 'control-plane',
      seq: 3,
      hash: 'a'.repeat(64),
      checkpoint_ts: '2026-09-25T10:00:00.000Z',
      key_version: 1,
      signature: 'AAAA',
    };
    const text = [
      JSON.stringify({ ts: 'x', level: 'info', msg: 'audit_checkpoint', ...record }),
      JSON.stringify({ msg: 'sealer_started' }),
      'not json',
      JSON.stringify({ msg: 'audit_checkpoint', ...record, seq: '3' }),
      '',
    ].join('\n');
    expect(parseCheckpointLog(text)).toEqual([record]);
  });
});
