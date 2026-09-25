// The disk spool (SEC-F002-24): private files and directory, atomic append, replay with
// details.server.{original_ts, spooled}, stop-and-keep on failure, loss signal when not persistent.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoredEventInput } from '../src/audit/columns.js';
import { systemEvent } from '../src/audit/events.js';
import { openAuditSpool } from '../src/audit/spool.js';
import { AuditUnavailableError } from '../src/audit/writer.js';
import { createMemoryMetrics } from '../src/observability/metrics.js';

const ORG = '0192f0a0-7b3c-7d4e-8f00-00000000000f';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const base = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ralysa-spool-'));
  dirs.push(dir);
  return dir;
};
const event = (n: number) =>
  systemEvent({
    action: 'auth.token_rejected',
    outcome: 'denied',
    service: 'rts',
    details: { n, server: { k: 1 } },
  });

describe('audit spool', () => {
  it('creates a private directory and 0600 files', async () => {
    const dir = join(base(), 'spool');
    const spool = await openAuditSpool({ dir, persistent: true });
    await spool.append(ORG, [event(1)]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
    await expect(spool.pending()).resolves.toBe(1);
  });

  it('replays in order with details.server.original_ts and spooled, then deletes the files', async () => {
    const dir = join(base(), 'spool');
    let clock = Date.parse('2026-09-25T10:00:00.000Z');
    const spool = await openAuditSpool({ dir, persistent: true, now: () => new Date(clock++) });
    await spool.append(ORG, [event(1), event(2)]);
    await spool.append(ORG, [event(3)]);
    const seen: { org: string; events: StoredEventInput[] }[] = [];
    const result = await spool.replay((org, events) => {
      seen.push({ org, events });
      return Promise.resolve(
        events.map((e) => ({ event_id: e.event_id, status: 'stored' as const })),
      );
    });
    expect(result).toEqual({ replayed: 3, pending: 0 });
    expect(seen.map((s) => s.events.map((e) => e.details.n))).toEqual([[1, 2], [3]]);
    expect(seen[0]?.events[0]?.details.server).toEqual({
      k: 1,
      original_ts: '2026-09-25T10:00:00.000Z',
      spooled: true,
    });
    expect(seen[0]?.org).toBe(ORG);
    await expect(spool.pending()).resolves.toBe(0);
  });

  it('stops at the first failed write and keeps that file and later ones', async () => {
    const dir = join(base(), 'spool');
    let clock = 1;
    const spool = await openAuditSpool({ dir, persistent: true, now: () => new Date(clock++) });
    for (const n of [1, 2, 3]) await spool.append(ORG, [event(n)]);
    let calls = 0;
    const result = await spool.replay(() => {
      calls++;
      return calls === 2 ? Promise.reject(new AuditUnavailableError('down')) : Promise.resolve([]);
    });
    expect(result).toEqual({ replayed: 1, pending: 2 });
    await expect(spool.pending()).resolves.toBe(2);
  });

  it('refuses a symlinked directory', async () => {
    const root = base();
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    await expect(openAuditSpool({ dir: join(root, 'link'), persistent: true })).rejects.toThrow(
      /symlink/,
    );
  });

  it('emits audit_spool_lost_total at start when not on a persistent volume', async () => {
    const metrics = createMemoryMetrics();
    await openAuditSpool({ dir: join(base(), 's'), persistent: false, metrics });
    expect(metrics.counter('audit_spool_lost_total')).toBe(1);
    const other = createMemoryMetrics();
    await openAuditSpool({ dir: join(base(), 's'), persistent: true, metrics: other });
    expect(other.counter('audit_spool_lost_total')).toBe(0);
  });

  it('quarantines unparseable or unknown-version files and replays the rest (review of #21)', async () => {
    const dir = join(base(), 'spool');
    const metrics = createMemoryMetrics();
    const spool = await openAuditSpool({ dir, persistent: true, metrics, now: () => new Date(5) });
    writeFileSync(
      join(dir, 'spool-0000000000001-00000000-0000-4000-8000-000000000001.json'),
      '{not json',
      {
        mode: 0o600,
      },
    );
    writeFileSync(
      join(dir, 'spool-0000000000002-00000000-0000-4000-8000-000000000002.json'),
      JSON.stringify({ version: 9, org_id: ORG, original_ts: 'x', events: [] }),
      { mode: 0o600 },
    );
    await spool.append(ORG, [event(1)]);
    const result = await spool.replay(() => Promise.resolve([]));
    expect(result).toEqual({ replayed: 1, pending: 0 });
    expect(readdirSync(join(dir, 'quarantine'))).toHaveLength(2);
    expect(metrics.counter('audit_spool_quarantined_total')).toBe(2);
  });

  it('removes stale temp files left by a crash at start', async () => {
    const dir = join(base(), 'spool');
    mkdirSync(dir, { mode: 0o700 });
    const stale = join(dir, '.spool-0000000000001-00000000-0000-4000-8000-000000000001.json.tmp');
    writeFileSync(stale, '{"half":', { mode: 0o600 });
    const spool = await openAuditSpool({ dir, persistent: true });
    expect(existsSync(stale)).toBe(false);
    await expect(spool.pending()).resolves.toBe(0);
  });
});
