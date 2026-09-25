// Hash chain over audit events (F-002 design §4.6, ADR-0021; [AR-5], [AR-7]).
//
//   event_hash = SHA-256(JCS(omit-null envelope rebuilt from the stored row))
//   hash       = SHA-256(prev_hash ‖ event_hash); prev_hash of seq 1 = 32 zero bytes
//
// One chain per (org_id, shard), shard = `source` in Phase 0. rowToEnvelope() is shared by the
// sealer and verifyChain(), so both hash exactly what the database holds.
import { GENESIS_PREV_HASH, chainHash, eventHash } from '@ralysa/protocol/audit';
import { toHex } from '@ralysa/protocol/common';
import type { Kysely, Selectable } from 'kysely';
import { withOrg } from '../../db/kysely.js';
import type { AuditEventTable, Database } from '../../db/types.js';

export type AuditEventRow = Selectable<AuditEventTable>;

const intOrNull = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

/** The stored envelope (§3.5) from a row. Null columns become null members (omitted when hashed). */
export function rowToEnvelope(row: AuditEventRow): Record<string, unknown> {
  const details =
    typeof row.details === 'string' ? (JSON.parse(row.details) as unknown) : row.details;
  return {
    event_id: row.event_id,
    action: row.action,
    actor: {
      type: row.actor_type,
      user_id: row.actor_user_id,
      idp_subject: row.actor_idp_subject,
      service: row.actor_service,
    },
    act: row.act_sub === null ? null : { sub: row.act_sub },
    surface: row.surface,
    resource:
      row.resource_type === null && row.resource_id === null
        ? null
        : { type: row.resource_type, id: row.resource_id },
    operation: row.operation,
    outcome: row.outcome,
    reason_code: row.reason_code,
    session_id: row.session_id,
    turn_id: row.turn_id,
    request_id: row.request_id,
    tool_call_id: row.tool_call_id,
    trace_id: row.trace_id,
    span_id: row.span_id,
    policy_version: row.policy_version,
    entitlement_version: row.entitlement_version,
    tier: row.tier,
    classification: row.classification,
    endpoint_id: row.endpoint_id,
    endpoint_region: row.endpoint_region,
    inference_region: row.inference_region,
    inference_region_source: row.inference_region_source,
    locality: row.locality,
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    cache_read_tokens: row.cache_read_tokens,
    cache_write_tokens: row.cache_write_tokens,
    payload_hash: row.payload_hash,
    details,
    schema_version: row.schema_version,
    ts: row.ts.toISOString(), // always exactly 3 fractional digits and Z [AR-5]
    org_id: row.org_id,
    source: row.source,
    attestation: row.attestation,
    client_seq: intOrNull(row.client_seq),
  };
}

export async function rowEventHash(row: AuditEventRow): Promise<Uint8Array> {
  return eventHash(rowToEnvelope(row));
}

export interface SealRecord {
  seq: number;
  event_hash: Uint8Array;
  prev_hash: Uint8Array;
  hash: Uint8Array;
  event: AuditEventRow;
}

export type ChainVerdict =
  | { ok: true; length: number; head: string | null }
  | {
      ok: false;
      seq: number;
      reason: 'seq_gap' | 'prev_hash_mismatch' | 'event_hash_mismatch' | 'hash_mismatch';
    };

const equal = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Recomputes every link; reports the first divergent seq. Seals must be in seq order. */
export async function verifySeals(seals: readonly SealRecord[]): Promise<ChainVerdict> {
  let prev = GENESIS_PREV_HASH;
  let expected = 1;
  for (const seal of seals) {
    if (seal.seq !== expected) return { ok: false, seq: expected, reason: 'seq_gap' };
    if (!equal(seal.prev_hash, prev))
      return { ok: false, seq: seal.seq, reason: 'prev_hash_mismatch' };
    const recomputed = await rowEventHash(seal.event);
    if (!equal(seal.event_hash, recomputed)) {
      return { ok: false, seq: seal.seq, reason: 'event_hash_mismatch' };
    }
    const hash = await chainHash(prev, recomputed);
    if (!equal(seal.hash, hash)) return { ok: false, seq: seal.seq, reason: 'hash_mismatch' };
    prev = hash;
    expected++;
  }
  return { ok: true, length: seals.length, head: seals.length === 0 ? null : toHex(prev) };
}

export interface StoredSeal extends SealRecord {
  sealed_at: Date;
}

/** One (org, shard) chain in seq order, with its events, for a role that can SELECT both. */
export async function readSeals(
  db: Kysely<Database>,
  orgId: string,
  shard: string,
): Promise<StoredSeal[]> {
  const rows = await withOrg(db, orgId, (trx) =>
    trx
      .selectFrom('audit.audit_seal as s')
      .innerJoin('audit.audit_event as e', 'e.event_id', 's.event_id')
      .selectAll('e')
      .select([
        's.seq as seal_seq',
        's.event_hash as seal_event_hash',
        's.prev_hash as seal_prev_hash',
        's.hash as seal_hash',
        's.sealed_at as seal_sealed_at',
      ])
      .where('s.shard', '=', shard)
      .orderBy('s.seq')
      .execute(),
  );
  return rows.map(
    ({ seal_seq, seal_event_hash, seal_prev_hash, seal_hash, seal_sealed_at, ...event }) => ({
      seq: Number(seal_seq),
      event_hash: seal_event_hash,
      prev_hash: seal_prev_hash,
      hash: seal_hash,
      sealed_at: seal_sealed_at,
      event,
    }),
  );
}

/**
 * Reads one (org, shard) chain with a role that can SELECT seals and events (reader or sealer)
 * and verifies it from genesis. audit-verify also compares it with the signed checkpoints.
 */
export async function verifyChain(
  db: Kysely<Database>,
  orgId: string,
  shard: string,
): Promise<ChainVerdict> {
  return verifySeals(await readSeals(db, orgId, shard));
}
