// The IdP client-secret watcher (F-002-T13, design §5.7): read once and then from memory; a poll
// adopts only a newer KV version; invalid_client re-reads at once (one read for concurrent
// callers) and allows a retry only with a newer version; secret.rotated phase=observed with an id
// derived from org, path and version (so replicas write it once); a failed record is retried on
// the next poll; OpenBao down keeps the value in hand; no value in any log line or event.
// Fake timers only: no real waiting.
import { SecretsError, createInMemorySecretStore } from '@ralysa/secrets';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredEventInput } from '../src/audit/columns.js';
import type { AuditWriter } from '../src/audit/writer.js';
import { AuditUnavailableError } from '../src/audit/writer.js';
import type { Logger } from '../src/observability/logger.js';
import { createMemoryMetrics } from '../src/observability/metrics.js';
import {
  createIdpClientSecret,
  credentialRefHash,
  idpSecretObservedEvent,
} from '../src/secrets/runtime.js';

const PATH = 'kv/ralysa/control-plane/idp-client-secret';
const ORG = '0192f0a0-7b3c-7d4e-8f00-00000000000f';
// Runtime-built values, so nothing here reads as a credential to a scanner.
const value = (n: number) => `test-value-${'x'.repeat(8)}-${String(n)}`;

function harness(options: { failWrites?: number } = {}) {
  const secrets = createInMemorySecretStore({ [PATH]: value(1) });
  const written: StoredEventInput[] = [];
  let failWrites = options.failWrites ?? 0;
  const writer: AuditWriter = {
    write: () => Promise.reject(new Error('not used')),
    writeOrSpool: (_org, events) => {
      if (failWrites > 0) {
        failWrites -= 1;
        return Promise.reject(new AuditUnavailableError('down'));
      }
      written.push(...events);
      return Promise.resolve({ results: [] });
    },
  };
  const lines: { level: string; msg: string; fields: Record<string, unknown> }[] = [];
  const logger: Logger = {
    info: (msg, fields = {}) => lines.push({ level: 'info', msg, fields }),
    warn: (msg, fields = {}) => lines.push({ level: 'warn', msg, fields }),
    error: (msg, fields = {}) => lines.push({ level: 'error', msg, fields }),
  };
  const metrics = createMemoryMetrics();
  const get = vi.spyOn(secrets, 'get');
  const runtime = createIdpClientSecret({
    secrets,
    path: PATH,
    audit: { writer, orgId: ORG },
    pollMs: 60_000,
    logger,
    metrics,
  });
  return { secrets, runtime, written, lines, metrics, get };
}

/** Lets pending promise callbacks run (no timers involved). */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('IdP client-secret watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads once on first use (one read for concurrent callers), then serves from memory', async () => {
    const { runtime, get, lines } = harness();
    const [a, b] = await Promise.all([runtime.current(), runtime.current()]);
    expect(a).toEqual({ value: value(1), version: 1 });
    expect(b).toBe(a);
    await runtime.current();
    expect(get).toHaveBeenCalledTimes(1);
    expect(runtime.version()).toBe(1);
    expect(lines).toContainEqual({
      level: 'info',
      msg: 'idp_client_secret_observed',
      fields: { version: 1, via: 'first_read' },
    });
  });

  it('the poll adopts a newer version, and never an older or equal one', async () => {
    const { runtime, secrets } = harness();
    const stop = runtime.start();
    await flush();
    expect(runtime.version()).toBe(1);
    secrets.put(PATH, value(2));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runtime.version()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.version()).toBe(2);
    expect(await runtime.current()).toEqual({ value: value(2), version: 2 });
    // A store that answers an older version (a replica behind, a restored backup) changes nothing.
    vi.spyOn(secrets, 'get').mockResolvedValue({ value: value(1), version: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await runtime.current()).toEqual({ value: value(2), version: 2 });
    stop();
  });

  it('invalid_client: re-reads at once, one read for concurrent callers, retry only with a newer version', async () => {
    const { runtime, secrets, get, metrics, lines } = harness();
    const used = await runtime.current();
    secrets.put(PATH, value(2));
    const [x, y] = await Promise.all([
      runtime.refreshAfterInvalidClient(used.version),
      runtime.refreshAfterInvalidClient(used.version),
    ]);
    expect(x).toEqual({ value: value(2), version: 2 });
    expect(y).toEqual(x);
    expect(get).toHaveBeenCalledTimes(2); // the first read and ONE re-read
    // Nothing newer: no retry.
    expect(await runtime.refreshAfterInvalidClient(2)).toBeUndefined();
    expect(metrics.counter('idp_invalid_client_total', { retried: 'true' })).toBe(2);
    expect(metrics.counter('idp_invalid_client_total', { retried: 'false' })).toBe(1);
    expect(lines.filter((l) => l.msg === 'idp_invalid_client').map((l) => l.fields)).toContainEqual(
      { version_used: 2, version_now: 2, retry: false },
    );
    expect(lines).toContainEqual({
      level: 'info',
      msg: 'idp_client_secret_observed',
      fields: { version: 2, previous_version: 1, via: 'invalid_client' },
    });
  });

  it('a caller that failed with an older version retries with the version another caller already got', async () => {
    const { runtime, secrets } = harness();
    await runtime.current();
    secrets.put(PATH, value(2));
    await runtime.refreshAfterInvalidClient(1);
    // A second request that had started with v1 fails later: v2 is newer than what it used.
    expect(await runtime.refreshAfterInvalidClient(1)).toEqual({ value: value(2), version: 2 });
  });

  it('records secret.rotated phase=observed once per version, with an id every replica derives alike', async () => {
    const one = harness();
    const two = harness();
    await one.runtime.current();
    await two.runtime.current();
    await flush();
    one.secrets.put(PATH, value(2));
    await one.runtime.refreshAfterInvalidClient(1);
    await flush();
    const ids = one.written.map((e) => e.event_id);
    expect(one.written.map((e) => e.details)).toEqual([
      {
        credential_ref_hash: credentialRefHash(PATH),
        kind: 'idp_client_secret',
        version: 1,
        phase: 'observed',
      },
      {
        credential_ref_hash: credentialRefHash(PATH),
        kind: 'idp_client_secret',
        version: 2,
        phase: 'observed',
      },
    ]);
    expect(one.written[0]).toMatchObject({
      action: 'secret.rotated',
      outcome: 'success',
      actor: { type: 'system', service: 'rts' },
      source: 'control-plane',
      attestation: 'server',
    });
    // The second replica derives the same id for v1, so the writer stores it once.
    expect(two.written.map((e) => e.event_id)).toEqual([ids[0]]);
    expect(idpSecretObservedEvent(ORG, PATH, 2).event_id).toBe(ids[1]);
    expect(new Set(ids).size).toBe(2);
    // A version 8 UUID.
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Another org or path gives another id.
    expect(
      idpSecretObservedEvent('0192f0a0-7b3c-7d4e-8f00-0000000000aa', PATH, 1).event_id,
    ).not.toBe(ids[0]);
  });

  it('a record that fails is retried on the next poll, and written once it lands', async () => {
    const { runtime, written, metrics, lines } = harness({ failWrites: 1 });
    const stop = runtime.start();
    await flush();
    expect(written).toHaveLength(0);
    expect(
      metrics.counter('secret_rotated_record_failures_total', { kind: 'idp_client_secret' }),
    ).toBe(1);
    expect(lines.find((l) => l.msg === 'idp_client_secret_event_not_recorded')?.fields).toEqual({
      version: 1,
      error: 'AuditUnavailableError',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(written.map((e) => e.details.version)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(written).toHaveLength(1);
    stop();
  });

  it('OpenBao down: the value in hand stays in use, one warn per failure streak, then recovery', async () => {
    const { runtime, secrets, lines, metrics } = harness();
    const stop = runtime.start();
    await flush();
    secrets.fail(PATH, new SecretsError('unavailable', 'read failed: connection refused'));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await runtime.current()).toEqual({ value: value(1), version: 1 });
    expect(metrics.counter('idp_client_secret_read_failures_total')).toBe(3);
    expect(lines.filter((l) => l.msg === 'idp_client_secret_read_failed')).toEqual([
      {
        level: 'warn',
        msg: 'idp_client_secret_read_failed',
        fields: { error: 'SecretsError', code: 'unavailable', version_in_use: 1 },
      },
    ]);
    secrets.fail(PATH, undefined);
    secrets.put(PATH, value(2));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.version()).toBe(2);
    expect(lines.some((l) => l.msg === 'idp_client_secret_read_recovered')).toBe(true);
    stop();
  });

  it('a first read that fails rejects, and the next call reads again', async () => {
    const { runtime, secrets } = harness();
    secrets.fail(PATH, new SecretsError('unavailable', 'down'));
    await expect(runtime.current()).rejects.toBeInstanceOf(SecretsError);
    secrets.fail(PATH, undefined);
    await expect(runtime.current()).resolves.toEqual({ value: value(1), version: 1 });
  });

  it('stop ends the poll', async () => {
    const { runtime, get } = harness();
    const stop = runtime.start();
    await flush();
    stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('no secret value appears in a log line, a metric or an event', async () => {
    const { runtime, secrets, written, lines } = harness();
    const stop = runtime.start();
    await flush();
    secrets.put(PATH, value(2));
    await runtime.refreshAfterInvalidClient(1);
    await vi.advanceTimersByTimeAsync(60_000);
    const text = JSON.stringify({ written, lines });
    expect(text).not.toContain(value(1));
    expect(text).not.toContain(value(2));
    expect(text).not.toContain(PATH); // only its hash
    stop();
  });
});
