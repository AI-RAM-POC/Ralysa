// Signed chain-head checkpoints and the checkpoint key's custody monitor (F-002 design §4.7,
// §3.2.4; D-28; SEC-F002-01 c, SEC-F002-11).
//
// Every checkpoint interval (60 s), for each (org, shard) with seals after its last checkpoint,
// the sealer signs checkpointPayload({org_id, shard, seq, hash, checkpoint_ts}) with the latest
// version of the Transit key ralysa-audit-checkpoint, inserts audit.audit_checkpoint, and logs the
// same record (`msg: audit_checkpoint`, no PII) so a log pipeline keeps an off-host copy that
// audit-verify --log-checkpoints compares against the table.
//
// Custody: every poll (30 s) the key is described again. If `exportable` or
// `allow_plaintext_backup` is set, checkpoint signing stops (sealing continues, so audit-verify
// will report checkpoint_gap), `secret.custody_violation` is written once per violation, and the
// state is exposed for readiness. Signing resumes when both flags are false again.
import { CHECKPOINT_KEY, checkpointPayload } from '@ralysa/protocol/audit';
import { toHex } from '@ralysa/protocol/common';
import { CustodyViolationError, type KeyCustody } from '@ralysa/secrets';
import { type Kysely, sql } from 'kysely';
import { withOrg } from '../../db/kysely.js';
import type { Database } from '../../db/types.js';
import type { Logger } from '../../observability/logger.js';
import { type Metrics, noopMetrics } from '../../observability/metrics.js';
import { systemEvent } from '../events.js';
import type { AuditWriter } from '../writer.js';

export const CHECKPOINT_INTERVAL_MS = 60_000;
export const CUSTODY_POLL_MS = 30_000;

export interface CheckpointSigner {
  /** Re-describes the key; returns whether signing is allowed. */
  poll(): Promise<boolean>;
  healthy(): boolean;
  keyVersion(): number | undefined;
  sign(payload: Uint8Array): Promise<{ keyVersion: number; signature: Uint8Array }>;
}

export interface CheckpointSignerOptions {
  custody: KeyCustody;
  key?: string;
  orgId: string;
  /** Writes secret.custody_violation (the sealer's insert-only writer). */
  writer: AuditWriter;
  logger: Logger;
  metrics?: Metrics;
}

export function createCheckpointSigner(options: CheckpointSignerOptions): CheckpointSigner {
  const key = options.key ?? CHECKPOINT_KEY;
  const metrics = options.metrics ?? noopMetrics;
  let version: number | undefined;
  let violation: string | undefined;

  const report = async (flag: string) => {
    options.logger.error('secret_custody_violation', { key, flag });
    metrics.gauge('secret_custody_violation', 1, { key });
    try {
      await options.writer.writeOrSpool(options.orgId, [
        systemEvent({
          action: 'secret.custody_violation',
          outcome: 'error',
          service: 'sealer',
          reasonCode: flag,
          details: { key, flag },
        }),
      ]);
    } catch (error) {
      options.logger.error('secret_custody_violation_not_recorded', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    async poll() {
      try {
        const described = await options.custody.describe(key);
        version = described.latestVersion;
        if (violation !== undefined) {
          options.logger.info('secret_custody_restored', { key });
          metrics.gauge('secret_custody_violation', 0, { key });
        }
        violation = undefined;
        return true;
      } catch (error) {
        if (!(error instanceof CustodyViolationError)) {
          // OpenBao unreachable or similar: keep the last known state, don't sign blind.
          options.logger.warn('checkpoint_key_describe_failed', {
            key,
            error: error instanceof Error ? error.message : String(error),
          });
          return violation === undefined && version !== undefined;
        }
        const flag = error.exportable ? 'exportable' : 'allow_plaintext_backup';
        if (violation !== flag) {
          violation = flag;
          await report(flag);
        }
        return false;
      }
    },
    healthy: () => violation === undefined && version !== undefined,
    keyVersion: () => version,
    async sign(payload) {
      if (violation !== undefined || version === undefined) {
        throw new Error(`checkpoint key ${key} is not usable (custody)`);
      }
      return { keyVersion: version, signature: await options.custody.sign(key, version, payload) };
    },
  };
}

export interface CheckpointRecord {
  org_id: string;
  shard: string;
  seq: number;
  hash: string;
  checkpoint_ts: string;
  key_version: number;
  /** base64url of the raw r‖s signature. */
  signature: string;
}

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** One checkpoint pass over the given shards. Returns the checkpoints written. */
export async function checkpointOnce(options: {
  db: Kysely<Database>;
  orgId: string;
  shards: readonly string[];
  signer: CheckpointSigner;
  logger: Logger;
}): Promise<CheckpointRecord[]> {
  if (!options.signer.healthy()) return [];
  const written: CheckpointRecord[] = [];
  for (const shard of options.shards) {
    const record = await withOrg(options.db, options.orgId, async (trx) => {
      // The seal pass's per-shard lock: one replica checkpoints a shard at a time, and the head
      // can't move while it is signed.
      const { rows: lock } = await sql<{ locked: boolean }>`
        select pg_try_advisory_xact_lock(hashtext(${`${options.orgId}:${shard}`})) as locked`.execute(
        trx,
      );
      if (lock[0]?.locked !== true) return undefined;
      const head = await trx
        .selectFrom('audit.audit_seal')
        .select(['seq', 'hash'])
        .where('shard', '=', shard)
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (head === undefined) return undefined;
      const last = await trx
        .selectFrom('audit.audit_checkpoint')
        .select('seq')
        .where('shard', '=', shard)
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (last !== undefined && BigInt(last.seq) >= BigInt(head.seq)) return undefined;
      const { rows } = await sql<{ ts: Date }>`
        select date_trunc('milliseconds', clock_timestamp()) as ts`.execute(trx);
      const checkpointTs = (rows[0]?.ts ?? new Date()).toISOString();
      const hash = toHex(new Uint8Array(head.hash));
      const seq = Number(head.seq);
      const payload = checkpointPayload({
        org_id: options.orgId,
        shard,
        seq,
        hash,
        checkpoint_ts: checkpointTs,
      });
      const { keyVersion, signature } = await options.signer.sign(payload);
      await trx
        .insertInto('audit.audit_checkpoint')
        .values({
          org_id: options.orgId,
          shard,
          seq,
          hash: head.hash,
          checkpoint_ts: checkpointTs,
          key_version: keyVersion,
          signature,
        })
        .execute();
      return {
        org_id: options.orgId,
        shard,
        seq,
        hash,
        checkpoint_ts: checkpointTs,
        key_version: keyVersion,
        signature: b64u(signature),
      };
    });
    if (record !== undefined) {
      // The off-host copy (D-28): the same values, one line per checkpoint.
      options.logger.info('audit_checkpoint', { ...record });
      written.push(record);
    }
  }
  return written;
}
