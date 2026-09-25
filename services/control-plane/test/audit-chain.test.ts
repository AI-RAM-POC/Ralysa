// rowToEnvelope + JCS + chain hashing (F-002 design §4.6; [AR-5], [AR-7]): the stored row hashes
// to the protocol's frozen golden vector, the writer/reader mapping round-trips, and verifySeals
// reports the first divergent seq for every kind of tamper.
import { GENESIS_PREV_HASH, chainHash } from '@ralysa/protocol/audit';
import { toHex } from '@ralysa/protocol/common';
import { describe, expect, it } from 'vitest';
import { type StoredEventInput, toColumns } from '../src/audit/columns.js';
import {
  type AuditEventRow,
  type SealRecord,
  rowEventHash,
  rowToEnvelope,
  verifySeals,
} from '../src/audit/sealer/chain.js';

const ORG = '0192f0a0-7b3c-7d4e-8f00-00000000000f';
/** packages/protocol/test/jcs.test.ts BASE_EVENT, frozen golden values. */
const BASE_HASH = '939a8a46e933aa02d3bb25569abffa96be33966aecc2989baeb1ed96353d8a7e';
const BASE_CHAIN = '18c0ae2ec72a72445b9152793cde63104e0016b7c957666f4c83c65306706c3d';

const input: StoredEventInput = {
  event_id: '0192f0a0-7b3c-7d4e-8f00-000000000001',
  action: 'auth.sign_in',
  actor: {
    type: 'user',
    user_id: '0192f0a0-7b3c-7d4e-8f00-0000000000aa',
    idp_subject: '4f1c2e3d-0000-4000-8000-000000000001',
    service: null,
  },
  surface: 'cli',
  resource: null,
  outcome: 'success',
  reason_code: null,
  trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
  span_id: null,
  policy_version: 'p0-static:0123456789ab',
  details: { flow: 'idp_device', protocol: 'oidc', note: null },
  source: 'control-plane',
  attestation: 'server',
};

/** What pg returns for the row the writer inserted (jsonb parsed, bigint as string). */
function storedRow(
  event: StoredEventInput,
  ingestSeq = 1,
  ts = '2026-09-25T10:00:00.000Z',
): AuditEventRow {
  const columns = toColumns(ORG, event);
  return {
    ...(columns as Omit<AuditEventRow, 'ts' | 'ingest_seq' | 'schema_version' | 'details'>),
    details: JSON.parse(columns.details) as unknown,
    ts: new Date(ts),
    ingest_seq: String(ingestSeq),
    schema_version: 1,
  };
}

describe('rowToEnvelope and hashing', () => {
  it('the stored row hashes to the frozen golden vector (event hash and genesis chain hash)', async () => {
    const hash = await rowEventHash(storedRow(input));
    expect(toHex(hash)).toBe(BASE_HASH);
    expect(toHex(await chainHash(GENESIS_PREV_HASH, hash))).toBe(BASE_CHAIN);
  });

  it('absent and null envelope fields hash alike (omit-null [AR-7])', async () => {
    const withNulls = { ...input, turn_id: null, tokens_in: null, act: null };
    expect(toHex(await rowEventHash(storedRow(withNulls)))).toBe(BASE_HASH);
  });

  it('ts is always RFC 3339 with 3 fractional digits and Z [AR-5]', () => {
    expect(rowToEnvelope(storedRow(input, 1, '2026-09-25T10:00:00Z')).ts).toBe(
      '2026-09-25T10:00:00.000Z',
    );
  });

  it('maps structured members and bigint columns back', () => {
    const envelope = rowToEnvelope(
      storedRow({
        ...input,
        act: { sub: 'svc:agent-host' },
        resource: { type: 'model_endpoint', id: 'ep-1' },
        attestation: 'client',
        client_seq: 7,
      }),
    );
    expect(envelope).toMatchObject({
      act: { sub: 'svc:agent-host' },
      resource: { type: 'model_endpoint', id: 'ep-1' },
      client_seq: 7,
      org_id: ORG,
      schema_version: 1,
    });
  });

  it('every stored value change changes the hash', async () => {
    const base = toHex(await rowEventHash(storedRow(input)));
    for (const change of [
      { action: 'auth.sign_out' },
      { outcome: 'denied' as const },
      { details: { flow: 'loopback_pkce', protocol: 'oidc', note: null } },
      { source: 'model-gateway' as const },
    ]) {
      expect(toHex(await rowEventHash(storedRow({ ...input, ...change })))).not.toBe(base);
    }
  });
});

async function chainOf(rows: AuditEventRow[]): Promise<SealRecord[]> {
  const seals: SealRecord[] = [];
  let prev = GENESIS_PREV_HASH;
  for (const [i, event] of rows.entries()) {
    const eventHash = await rowEventHash(event);
    const hash = await chainHash(prev, eventHash);
    seals.push({ seq: i + 1, event_hash: eventHash, prev_hash: prev, hash, event });
    prev = hash;
  }
  return seals;
}

describe('verifySeals', () => {
  const rows = [1, 2, 3].map((n) =>
    storedRow({ ...input, event_id: `0192f0a0-7b3c-7d4e-8f00-00000000000${String(n)}` }, n),
  );

  it('accepts an intact chain and returns its head', async () => {
    const seals = await chainOf(rows);
    await expect(verifySeals(seals)).resolves.toEqual({
      ok: true,
      length: 3,
      head: toHex(seals[2]!.hash),
    });
    await expect(verifySeals([])).resolves.toEqual({ ok: true, length: 0, head: null });
  });

  it('a changed event is reported at its seq', async () => {
    const seals = await chainOf(rows);
    seals[1] = { ...seals[1]!, event: { ...seals[1]!.event, action: 'tampered.x' } };
    await expect(verifySeals(seals)).resolves.toEqual({
      ok: false,
      seq: 2,
      reason: 'event_hash_mismatch',
    });
  });

  it('a recomputed-but-unlinked seal, a missing seal and a wrong prev_hash are reported', async () => {
    const seals = await chainOf(rows);
    const badHash = [...seals];
    badHash[2] = { ...seals[2]!, hash: new Uint8Array(32) };
    await expect(verifySeals(badHash)).resolves.toMatchObject({ seq: 3, reason: 'hash_mismatch' });
    await expect(verifySeals([seals[0]!, seals[2]!])).resolves.toMatchObject({
      seq: 2,
      reason: 'seq_gap',
    });
    const badPrev = [...seals];
    badPrev[1] = { ...seals[1]!, prev_hash: new Uint8Array(32).fill(1) };
    await expect(verifySeals(badPrev)).resolves.toMatchObject({
      seq: 2,
      reason: 'prev_hash_mismatch',
    });
  });
});
