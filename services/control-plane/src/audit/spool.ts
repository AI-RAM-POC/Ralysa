// Disk spool for denials and non-blocking audit events (F-002 design §5.8, §6.4; SEC-F002-24).
//
// - A dedicated directory (default /var/lib/ralysa/audit-spool) with mode 0700, owned by this
//   process's user and not a symlink; one file per batch, mode 0600, written to a temp name,
//   fsync'd, renamed, and the directory fsync'd, so a crash leaves either the whole file or none.
//   Stale temp files from a crash are removed at start. Files hold PII (client_ip, HMACs).
// - A file that can't be parsed or has an unknown version is moved to quarantine/ (metric
//   audit_spool_quarantined_total) so it never blocks the replay of the files after it.
// - Replay stores each event with details.server.original_ts (when it was spooled) and
//   details.server.spooled = true; a replayed event that was in fact committed before the
//   failure comes back as `duplicate` (same event_id). A file is deleted only after every event
//   in it is stored or duplicate; replay stops at the first unavailable write.
// - Where no persistent volume backs the directory, loss on restart is accepted and
//   audit_spool_lost_total is emitted at start.
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../observability/logger.js';
import { type Metrics, noopMetrics } from '../observability/metrics.js';
import type { StoredEventInput } from './columns.js';
import type { WriteResult } from './writer.js';

export const DEFAULT_SPOOL_DIR = '/var/lib/ralysa/audit-spool';
const FILE = /^spool-\d{13}-[0-9a-f-]{36}\.json$/;

interface SpoolFile {
  version: 1;
  org_id: string;
  original_ts: string;
  events: StoredEventInput[];
}

function parseSpoolFile(text: string): SpoolFile | undefined {
  try {
    const body = JSON.parse(text) as Partial<SpoolFile>;
    const ok =
      body.version === 1 &&
      typeof body.org_id === 'string' &&
      typeof body.original_ts === 'string' &&
      Array.isArray(body.events) &&
      body.events.every(
        (e) => typeof e === 'object' && typeof (e as { details?: unknown }).details === 'object',
      );
    return ok ? (body as SpoolFile) : undefined;
  } catch {
    return undefined;
  }
}

async function fsyncPath(path: string, flags: 'r' | 'r+'): Promise<void> {
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface AuditSpool {
  append(orgId: string, events: readonly StoredEventInput[]): Promise<void>;
  /** Replays every file in order through `write`; returns the number of events stored/duplicate. */
  replay(
    write: (orgId: string, events: StoredEventInput[]) => Promise<WriteResult[]>,
  ): Promise<{ replayed: number; pending: number }>;
  pending(): Promise<number>;
}

export interface SpoolOptions {
  dir?: string;
  /** false when the directory isn't on a persistent volume (loss on restart accepted). */
  persistent: boolean;
  metrics?: Metrics;
  logger?: Logger;
  now?: () => Date;
}

async function secureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`audit spool ${dir} must be a real directory, not a symlink`);
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`audit spool ${dir} is not owned by this process's user`);
  }
  if ((info.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

export async function openAuditSpool(options: SpoolOptions): Promise<AuditSpool> {
  const dir = options.dir ?? DEFAULT_SPOOL_DIR;
  const metrics = options.metrics ?? noopMetrics;
  const now = options.now ?? (() => new Date());
  await secureDir(dir);

  const files = async (): Promise<string[]> =>
    (await readdir(dir)).filter((name) => FILE.test(name)).sort();

  // A crash between write and rename leaves a temp file: it was never acknowledged as spooled.
  for (const name of await readdir(dir)) {
    if (name.startsWith('.spool-') && name.endsWith('.tmp'))
      await rm(join(dir, name), { force: true });
  }
  const quarantine = join(dir, 'quarantine');

  if (!options.persistent) {
    metrics.increment('audit_spool_lost_total');
    options.logger?.warn('audit_spool_not_persistent', { dir });
  }

  return {
    async append(orgId, events) {
      if (events.length === 0) return;
      const at = now();
      const body: SpoolFile = {
        version: 1,
        org_id: orgId,
        original_ts: at.toISOString(),
        events: [...events],
      };
      const name = `spool-${String(at.getTime()).padStart(13, '0')}-${randomUUID()}.json`;
      const temp = join(dir, `.${name}.tmp`);
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(body));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, join(dir, name));
      await fsyncPath(dir, 'r');
    },

    async replay(write) {
      let replayed = 0;
      const names = await files();
      for (const [index, name] of names.entries()) {
        const path = join(dir, name);
        const body = parseSpoolFile(await readFile(path, 'utf8'));
        if (body === undefined) {
          await mkdir(quarantine, { mode: 0o700, recursive: true });
          await rename(path, join(quarantine, name));
          metrics.increment('audit_spool_quarantined_total');
          options.logger?.error('audit_spool_file_quarantined', { file: name });
          continue;
        }
        const events = body.events.map((event) => {
          const server =
            typeof event.details.server === 'object' && event.details.server !== null
              ? (event.details.server as Record<string, unknown>)
              : {};
          return {
            ...event,
            details: {
              ...event.details,
              server: { ...server, original_ts: body.original_ts, spooled: true },
            },
          };
        });
        try {
          await write(body.org_id, events);
        } catch (error) {
          options.logger?.warn('audit_spool_replay_stopped', {
            file: name,
            error: error instanceof Error ? error.message : String(error),
          });
          return { replayed, pending: names.length - index };
        }
        await rm(path);
        replayed += events.length;
      }
      return { replayed, pending: 0 };
    },

    async pending() {
      return (await files()).length;
    },
  };
}
