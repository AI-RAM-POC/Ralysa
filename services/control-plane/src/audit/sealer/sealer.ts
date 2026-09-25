// The sealer (F-002 design §4.6; SEC-F002-26). Runs as its own process (`control-plane sealer`)
// with only the ralysa_audit_sealer credential.
//
// Every pass, for each shard of the org: in ONE transaction scoped to the org, take
// pg_try_advisory_xact_lock(hashtext(org:shard)) (released at commit, so it can't leak on a
// pooled connection; another replica holding it → skip this shard), read the chain head, read
// unsealed events of that shard above (watermark − lookback) in ingest_seq order (anti-join on
// audit_seal), append seals, commit. The PK (org_id, shard, seq) is the fork guard. An event
// whose transaction commits late is picked up by the next pass within the lookback; the hourly
// sweep drops the lookback so nothing is ever skipped.
import { chainHash, GENESIS_PREV_HASH, Source } from '@ralysa/protocol/audit';
import { type Kysely, sql } from 'kysely';
import { withOrg } from '../../db/kysely.js';
import type { Database } from '../../db/types.js';
import type { Logger } from '../../observability/logger.js';
import { type Metrics, noopMetrics } from '../../observability/metrics.js';
import { type AuditEventRow, rowEventHash } from './chain.js';
import {
  CHECKPOINT_INTERVAL_MS,
  CUSTODY_POLL_MS,
  type CheckpointSigner,
  checkpointOnce,
} from './checkpoint.js';

export const SEAL_LOOKBACK_ROWS = 10_000;
export const SEAL_BATCH = 1_000;
export const SEAL_LAG_ALERT_SECONDS = 5;
/** Phase 0: one chain per source. */
export const SHARDS: readonly string[] = Source.options;

export interface ShardPass {
  shard: string;
  sealed: number;
  skipped: boolean;
  /** Oldest sealed event's age at sealing, in seconds (database clock). */
  lagSeconds: number;
}

export interface SealOptions {
  db: Kysely<Database>;
  orgId: string;
  shards?: readonly string[];
  /** Drop the lookback bound (hourly sweep). */
  sweep?: boolean;
  lookback?: number;
  batch?: number;
  metrics?: Metrics;
}

async function sealShard(options: SealOptions, shard: string): Promise<ShardPass> {
  const lookback = options.lookback ?? SEAL_LOOKBACK_ROWS;
  const batch = options.batch ?? SEAL_BATCH;
  return withOrg(options.db, options.orgId, async (trx) => {
    const lockKey = `${options.orgId}:${shard}`;
    const { rows: lock } = await sql<{ locked: boolean }>`
      select pg_try_advisory_xact_lock(hashtext(${lockKey})) as locked`.execute(trx);
    if (lock[0]?.locked !== true) return { shard, sealed: 0, skipped: true, lagSeconds: 0 };

    const head = await trx
      .selectFrom('audit.audit_seal as s')
      .innerJoin('audit.audit_event as e', 'e.event_id', 's.event_id')
      .select(['s.seq', 's.hash', 'e.ingest_seq'])
      .where('s.shard', '=', shard)
      .orderBy('s.seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    const watermark = head === undefined ? 0n : BigInt(head.ingest_seq);
    const from = options.sweep === true ? 0n : watermark - BigInt(lookback);

    const events: AuditEventRow[] = await trx
      .selectFrom('audit.audit_event as e')
      .selectAll('e')
      .where('e.source', '=', shard)
      .where('e.ingest_seq', '>', (from < 0n ? 0n : from).toString())
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('audit.audit_seal as s')
              .select(sql`1`.as('one'))
              .whereRef('s.event_id', '=', 'e.event_id'),
          ),
        ),
      )
      .orderBy('e.ingest_seq')
      .limit(batch)
      .execute();
    if (events.length === 0) return { shard, sealed: 0, skipped: false, lagSeconds: 0 };

    const { rows: clock } = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx);
    const dbNow = clock[0]?.now ?? new Date();
    let prev = head === undefined ? GENESIS_PREV_HASH : new Uint8Array(head.hash);
    let seq = head === undefined ? 0 : Number(head.seq);
    let lagSeconds = 0;
    for (const event of events) {
      const eventHashValue = await rowEventHash(event);
      const hash = await chainHash(prev, eventHashValue);
      seq++;
      await trx
        .insertInto('audit.audit_seal')
        .values({
          org_id: options.orgId,
          shard,
          seq,
          event_id: event.event_id,
          event_hash: eventHashValue,
          prev_hash: prev,
          hash,
        })
        .execute();
      prev = hash;
      lagSeconds = Math.max(lagSeconds, (dbNow.getTime() - event.ts.getTime()) / 1000);
    }
    return { shard, sealed: events.length, skipped: false, lagSeconds };
  });
}

/** One pass over every shard. A late event found by the sweep counts in audit_seal_late_total. */
export async function sealOnce(options: SealOptions): Promise<ShardPass[]> {
  const metrics = options.metrics ?? noopMetrics;
  const passes: ShardPass[] = [];
  for (const shard of options.shards ?? SHARDS) {
    const pass = await sealShard(options, shard);
    passes.push(pass);
    if (pass.sealed > 0) {
      metrics.gauge('audit_seal_lag_seconds', pass.lagSeconds, { shard });
      if (options.sweep === true)
        metrics.increment('audit_seal_late_total', { shard }, pass.sealed);
    }
  }
  return passes;
}

export interface SealerLoopOptions extends Omit<SealOptions, 'sweep'> {
  intervalMs?: number;
  sweepEveryMs?: number;
  logger: Logger;
  signal: AbortSignal;
  /** Signed chain-head checkpoints (T16). Without it the loop only seals. */
  checkpoints?: {
    signer: CheckpointSigner;
    intervalMs?: number;
    custodyPollMs?: number;
  };
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * The sealer process loop: a pass every `intervalMs` (1 s), a sweep every `sweepEveryMs` (1 h).
 * Keeps going through database errors (logged, metric); a lag above 5 s logs a warning (the
 * alert fires on the audit_seal_lag_seconds metric).
 */
export async function runSealerLoop(options: SealerLoopOptions): Promise<void> {
  const intervalMs = options.intervalMs ?? 1_000;
  const sweepEveryMs = options.sweepEveryMs ?? 3_600_000;
  const metrics = options.metrics ?? noopMetrics;
  let lastSweep = Date.now();
  const checkpoints = options.checkpoints;
  let lastCustodyPoll = 0;
  let lastCheckpoint = 0;
  if (checkpoints !== undefined) {
    await checkpoints.signer.poll();
    lastCustodyPoll = Date.now();
  }
  while (!options.signal.aborted) {
    const sweep = Date.now() - lastSweep >= sweepEveryMs;
    try {
      const passes = await sealOnce({ ...options, sweep });
      if (sweep) lastSweep = Date.now();
      for (const pass of passes) {
        if (pass.sealed > 0 && pass.lagSeconds > SEAL_LAG_ALERT_SECONDS) {
          options.logger.warn('audit_seal_lag_high', {
            shard: pass.shard,
            lag_seconds: pass.lagSeconds,
          });
        }
      }
      if (checkpoints !== undefined) {
        if (Date.now() - lastCustodyPoll >= (checkpoints.custodyPollMs ?? CUSTODY_POLL_MS)) {
          await checkpoints.signer.poll();
          lastCustodyPoll = Date.now();
        }
        if (Date.now() - lastCheckpoint >= (checkpoints.intervalMs ?? CHECKPOINT_INTERVAL_MS)) {
          await checkpointOnce({
            db: options.db,
            orgId: options.orgId,
            shards: options.shards ?? SHARDS,
            signer: checkpoints.signer,
            logger: options.logger,
          });
          lastCheckpoint = Date.now();
        }
      }
    } catch (error) {
      metrics.increment('audit_seal_errors_total');
      options.logger.error('audit_seal_pass_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await pause(intervalMs, options.signal);
  }
}
