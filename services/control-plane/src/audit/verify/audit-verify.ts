// audit-verify (F-002 design §4.7, D-28; SEC-F002-01 c/d). Read-only: the reader role plus the
// checkpoint key's public versions.
//
//   1. every checkpoint signature verifies against the public key of its key_version;
//   2. each shard's chain is recomputed from the EVENTS, from genesis (not trusted from the seals);
//   3. at every checkpoint seq, the recomputed hash equals the signed hash. An owner who rewrote
//      an event and recomputed every later seal passes (2) on the stored seals but fails here,
//      at the first checkpoint covering that seq, because it can't forge the signature;
//   4. cadence: consecutive checkpoints with seals between them are ≤ 120 s apart, and a seal
//      older than 120 s (on the DATABASE clock) is covered by a checkpoint (else checkpoint_gap:
//      e.g. a stopped sealer);
//   5. with logged checkpoints (--log-checkpoints), every logged checkpoint exists in the table
//      with the same values (deleted or replaced checkpoint rows).
// The first divergent seq per shard is reported. Every read runs in a READ ONLY transaction.
import { webcrypto } from 'node:crypto';
import { GENESIS_PREV_HASH, checkpointPayload, chainHash } from '@ralysa/protocol/audit';
import { toHex } from '@ralysa/protocol/common';
import type { PublicJwk } from '@ralysa/secrets';
import { type Kysely, sql } from 'kysely';
import { withOrg } from '../../db/kysely.js';
import type { Database } from '../../db/types.js';
import { readSeals, rowEventHash, verifySeals } from '../sealer/chain.js';
import type { CheckpointRecord } from '../sealer/checkpoint.js';

export const MAX_CHECKPOINT_GAP_MS = 120_000;

export type Finding =
  | { kind: 'chain_broken'; shard: string; seq: number; reason: string }
  | { kind: 'signature_invalid'; shard: string; seq: number; key_version: number }
  | { kind: 'unknown_key_version'; shard: string; seq: number; key_version: number }
  | { kind: 'checkpoint_mismatch'; shard: string; seq: number }
  | { kind: 'checkpoint_beyond_chain'; shard: string; seq: number }
  | { kind: 'checkpoint_gap'; shard: string; seq: number; detail: string }
  | { kind: 'checkpoint_missing'; shard: string; seq: number }
  | { kind: 'checkpoint_log_mismatch'; shard: string; seq: number };

export interface ShardReport {
  shard: string;
  length: number;
  checkpoints: number;
  firstDivergentSeq: number | null;
}

export interface AuditVerifyOptions {
  db: Kysely<Database>;
  orgId: string;
  shards: readonly string[];
  /** Public key per checkpoint key version. */
  publicKeys: ReadonlyMap<number, PublicJwk>;
  logCheckpoints?: readonly CheckpointRecord[];
  /** Defaults to the database clock (clock_timestamp()) over the reader connection. */
  now?: Date;
  maxGapMs?: number;
}

const subtle = webcrypto.subtle;
const importCache = new Map<string, Promise<webcrypto.CryptoKey>>();
function verifyKey(jwk: PublicJwk): Promise<webcrypto.CryptoKey> {
  const id = `${jwk.x}.${jwk.y}`;
  let key = importCache.get(id);
  if (key === undefined) {
    key = subtle.importKey('jwk', { ...jwk }, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'verify',
    ]);
    importCache.set(id, key);
  }
  return key;
}

export async function auditVerify(
  options: AuditVerifyOptions,
): Promise<{ findings: Finding[]; shards: ShardReport[] }> {
  const now =
    options.now ??
    (await withOrg(
      options.db,
      options.orgId,
      async (trx) =>
        (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now ??
        new Date(),
      { readOnly: true },
    ));
  const maxGap = options.maxGapMs ?? MAX_CHECKPOINT_GAP_MS;
  const findings: Finding[] = [];
  const reports: ShardReport[] = [];

  for (const shard of options.shards) {
    const shardFindings: Finding[] = [];
    const seals = await readSeals(options.db, options.orgId, shard);
    const checkpoints = await withOrg(
      options.db,
      options.orgId,
      (trx) =>
        trx
          .selectFrom('audit.audit_checkpoint')
          .selectAll()
          .where('shard', '=', shard)
          .orderBy('seq')
          .execute(),
      { readOnly: true },
    );

    // (2) the stored seals are internally consistent …
    const stored = await verifySeals(seals);
    if (!stored.ok)
      shardFindings.push({ kind: 'chain_broken', shard, seq: stored.seq, reason: stored.reason });
    // … and the chain recomputed from the events, which is what checkpoints are compared with.
    const recomputed = new Map<number, string>();
    let prev = GENESIS_PREV_HASH;
    for (const seal of seals) {
      prev = await chainHash(prev, await rowEventHash(seal.event));
      recomputed.set(seal.seq, toHex(prev));
    }

    for (const cp of checkpoints) {
      const seq = Number(cp.seq);
      const hash = toHex(new Uint8Array(cp.hash));
      // (1) signature
      const jwk = options.publicKeys.get(cp.key_version);
      if (jwk === undefined) {
        shardFindings.push({
          kind: 'unknown_key_version',
          shard,
          seq,
          key_version: cp.key_version,
        });
      } else {
        const payload = checkpointPayload({
          org_id: options.orgId,
          shard,
          seq,
          hash,
          checkpoint_ts: cp.checkpoint_ts.toISOString(),
        });
        const ok = await subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          await verifyKey(jwk),
          new Uint8Array(cp.signature),
          payload,
        );
        if (!ok)
          shardFindings.push({
            kind: 'signature_invalid',
            shard,
            seq,
            key_version: cp.key_version,
          });
      }
      // (3) agreement with the recomputed chain
      const expected = recomputed.get(seq);
      if (expected === undefined)
        shardFindings.push({ kind: 'checkpoint_beyond_chain', shard, seq });
      else if (expected !== hash) shardFindings.push({ kind: 'checkpoint_mismatch', shard, seq });
    }

    // (4) cadence
    for (const [i, b] of checkpoints.entries()) {
      const a = checkpoints[i - 1];
      if (a === undefined) continue;
      const gap = b.checkpoint_ts.getTime() - a.checkpoint_ts.getTime();
      if (BigInt(b.seq) > BigInt(a.seq) && gap > maxGap) {
        shardFindings.push({
          kind: 'checkpoint_gap',
          shard,
          seq: Number(a.seq) + 1,
          detail: `${String(Math.round(gap / 1000))} s between checkpoints`,
        });
      }
    }
    const lastCheckpoint = checkpoints.at(-1);
    const lastCheckpointSeq = lastCheckpoint === undefined ? 0 : Number(lastCheckpoint.seq);
    const firstUncovered = seals.find((s) => s.seq > lastCheckpointSeq);
    if (
      firstUncovered !== undefined &&
      now.getTime() - firstUncovered.sealed_at.getTime() > maxGap
    ) {
      shardFindings.push({
        kind: 'checkpoint_gap',
        shard,
        seq: firstUncovered.seq,
        detail: 'sealed more than 120 s ago and not covered by a checkpoint',
      });
    }

    // (5) logged checkpoints must all be in the table, unchanged
    const byseq = new Map(checkpoints.map((cp) => [Number(cp.seq), cp]));
    for (const logged of options.logCheckpoints ?? []) {
      if (logged.org_id !== options.orgId || logged.shard !== shard) continue;
      const row = byseq.get(logged.seq);
      if (row === undefined) {
        shardFindings.push({ kind: 'checkpoint_missing', shard, seq: logged.seq });
        continue;
      }
      const same =
        toHex(new Uint8Array(row.hash)) === logged.hash &&
        row.checkpoint_ts.toISOString() === logged.checkpoint_ts &&
        row.key_version === logged.key_version &&
        Buffer.from(row.signature).toString('base64url') === logged.signature;
      if (!same) shardFindings.push({ kind: 'checkpoint_log_mismatch', shard, seq: logged.seq });
    }

    findings.push(...shardFindings);
    reports.push({
      shard,
      length: seals.length,
      checkpoints: checkpoints.length,
      firstDivergentSeq:
        shardFindings.length === 0 ? null : Math.min(...shardFindings.map((f) => f.seq)),
    });
  }
  return { findings, shards: reports };
}

/** Parses a JSONL log (the sealer's lines); keeps the `audit_checkpoint` records. */
export function parseCheckpointLog(text: string): CheckpointRecord[] {
  const out: CheckpointRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const r = value as Partial<CheckpointRecord> & { msg?: unknown };
    if (
      r.msg === 'audit_checkpoint' &&
      typeof r.org_id === 'string' &&
      typeof r.shard === 'string' &&
      typeof r.seq === 'number' &&
      typeof r.hash === 'string' &&
      typeof r.checkpoint_ts === 'string' &&
      typeof r.key_version === 'number' &&
      typeof r.signature === 'string'
    ) {
      out.push({
        org_id: r.org_id,
        shard: r.shard,
        seq: r.seq,
        hash: r.hash,
        checkpoint_ts: r.checkpoint_ts,
        key_version: r.key_version,
        signature: r.signature,
      });
    }
  }
  return out;
}
