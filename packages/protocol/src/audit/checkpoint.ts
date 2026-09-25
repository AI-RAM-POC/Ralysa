// Signed chain-head checkpoints (F-002 design §4.7, D-28; SEC-F002-01 c). The sealer signs
// JCS({org_id, shard, seq, hash, checkpoint_ts}) with the Transit key ralysa-audit-checkpoint
// (ES256: SHA-256 over these bytes, raw r‖s signature); audit-verify and F-011 verify the same
// bytes against the published public key of `key_version`.
import { utf8 } from '../platform.js';
import { jcs } from './jcs.js';

export const CHECKPOINT_KEY = 'ralysa-audit-checkpoint';

export interface CheckpointHead {
  org_id: string;
  shard: string;
  seq: number;
  /** Chain hash at `seq`, 64 lowercase hex. */
  hash: string;
  /** RFC 3339 UTC with exactly 3 fractional digits and `Z`. */
  checkpoint_ts: string;
}

/** The exact bytes that are signed and verified. */
export function checkpointPayload(head: CheckpointHead): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(head.hash))
    throw new Error('checkpoint hash must be 64 lowercase hex');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(head.checkpoint_ts)) {
    throw new Error('checkpoint_ts must be RFC 3339 UTC with 3 fractional digits');
  }
  if (!Number.isSafeInteger(head.seq) || head.seq < 1)
    throw new Error('checkpoint seq must be ≥ 1');
  return utf8(
    jcs({
      org_id: head.org_id,
      shard: head.shard,
      seq: head.seq,
      hash: head.hash,
      checkpoint_ts: head.checkpoint_ts,
    }),
  );
}
