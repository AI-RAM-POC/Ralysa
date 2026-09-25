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
// `allow_plaintext_backup` is set, checkpoint signing stops for good (sealing continues, so
// audit-verify reports checkpoint_gap) and secret.custody_violation is recorded through
// audit.record_custody_violation() until the database confirms it. See createCheckpointSigner.
import { CHECKPOINT_KEY, checkpointPayload } from '@ralysa/protocol/audit';
import { toHex } from '@ralysa/protocol/common';
import { CustodyViolationError, type KeyCustody } from '@ralysa/secrets';
import { type Kysely, sql } from 'kysely';
import { withOrg } from '../../db/kysely.js';
import type { Database } from '../../db/types.js';
import type { Logger } from '../../observability/logger.js';
import { type Metrics, noopMetrics } from '../../observability/metrics.js';

export const CHECKPOINT_INTERVAL_MS = 60_000;
export const CUSTODY_POLL_MS = 30_000;

export interface CheckpointSigner {
  /** Re-describes the key; returns whether signing is allowed. */
  poll(): Promise<boolean>;
  healthy(): boolean;
  keyVersion(): number | undefined;
  sign(payload: Uint8Array): Promise<{ keyVersion: number; signature: Uint8Array }>;
}

export interface CustodyFlags {
  exportable: boolean;
  allowPlaintextBackup: boolean;
}

/** Records a violation; true = inserted, false = already recorded in the last 5 minutes. */
export type CustodyRecorder = (flags: CustodyFlags) => Promise<boolean>;

/**
 * The sealer's recorder: audit.record_custody_violation() (audit/0002) on the SEALER's own pool,
 * inside withOrg(config.org.id). The sealer holds no writer credential (SEC-F002-34).
 */
export function dbCustodyRecorder(
  db: Kysely<Database>,
  orgId: string,
  /** The logical key recorded; the function allow-lists exactly this name (audit/0002, B4). */
  key: string = CHECKPOINT_KEY,
): CustodyRecorder {
  return (flags) =>
    withOrg(db, orgId, async (trx) => {
      const { rows } = await sql<{ recorded: boolean }>`
        select audit.record_custody_violation(${key}, ${flags.exportable}, ${flags.allowPlaintextBackup})
          as recorded`.execute(trx);
      return rows[0]?.recorded === true;
    });
}

export interface CheckpointSignerOptions {
  custody: KeyCustody;
  key?: string;
  recordViolation: CustodyRecorder;
  logger: Logger;
  metrics?: Metrics;
}

const pairOf = (flags: CustodyFlags): string =>
  `${String(flags.exportable)}/${String(flags.allowPlaintextBackup)}`;

/**
 * The checkpoint signer and its custody monitor. A custody violation is TERMINAL for the life of
 * the process (SEC-F002-35 a): OpenBao, like Vault, can't turn `exportable` or
 * `allow_plaintext_backup` off again, so a key that later reads as clean has been recreated under
 * the same name (SEC-F002-37). Signing stays stopped and that is logged; recovery is a new key
 * (runbook). The violation is recorded with both flags (SEC-F002-40) and retried on every poll
 * until the database confirms it (SEC-F002-39); the function's 5-minute dedupe keeps retries
 * from duplicating. A flag seen once stays set, so a second flag appearing later is a new pair
 * and is recorded too.
 */
export function createCheckpointSigner(options: CheckpointSignerOptions): CheckpointSigner {
  const key = options.key ?? CHECKPOINT_KEY;
  const metrics = options.metrics ?? noopMetrics;
  let version: number | undefined;
  let violation: CustodyFlags | undefined;
  let recordedPair: string | undefined;

  const record = async (flags: CustodyFlags) => {
    if (recordedPair === pairOf(flags)) return;
    try {
      await options.recordViolation(flags);
      recordedPair = pairOf(flags);
    } catch (error) {
      metrics.increment('secret_custody_violation_record_failures_total', { key });
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
        if (violation !== undefined) {
          // Reachable only if the key was recreated under the same name (SEC-F002-37).
          options.logger.error('checkpoint_key_clean_after_violation', {
            key,
            action: 'signing stays stopped',
          });
          await record(violation);
          return false;
        }
        version = described.latestVersion;
        return true;
      } catch (error) {
        if (!(error instanceof CustodyViolationError)) {
          // OpenBao unreachable or similar: keep the last known state, don't sign blind.
          options.logger.warn('checkpoint_key_describe_failed', {
            key,
            error: error instanceof Error ? error.message : String(error),
          });
          if (violation !== undefined) await record(violation);
          return violation === undefined && version !== undefined;
        }
        const flags: CustodyFlags = {
          exportable: error.exportable || (violation?.exportable ?? false),
          allowPlaintextBackup:
            error.allowPlaintextBackup || (violation?.allowPlaintextBackup ?? false),
        };
        if (violation === undefined || pairOf(violation) !== pairOf(flags)) {
          options.logger.error('secret_custody_violation', {
            key,
            exportable: flags.exportable,
            allow_plaintext_backup: flags.allowPlaintextBackup,
          });
          metrics.gauge('secret_custody_violation', 1, { key });
        }
        violation = flags;
        await record(flags);
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
