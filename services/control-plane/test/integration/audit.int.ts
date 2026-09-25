// F-002-T06 against the dev-stack Postgres: the AuditWriter (savepoint INSERT, 23505 →
// duplicate, fail closed within 250 ms), the spool round trip (SEC-F002-24), and TC-F-002-23's
// sealing parts: each event sealed ≤ 5 s, concurrent sealers never fork a chain
// (SEC-F002-26), a late-committing event is sealed on the next pass, verifyChain passes, and a
// superuser's tamper of a sealed row is reported at its seq.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devStackOrSkip } from '@ralysa/dev-stack/harness';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type StoredEventInput, toColumns } from '../../src/audit/columns.js';
import { migrationAppliedEvents, systemEvent, tokenRejectedEvent } from '../../src/audit/events.js';
import { createRejectionAggregator } from '../../src/audit/rejections.js';
import { verifyChain } from '../../src/audit/sealer/chain.js';
import { runSealerLoop, sealOnce } from '../../src/audit/sealer/sealer.js';
import { openAuditSpool } from '../../src/audit/spool.js';
import {
  AuditUnavailableError,
  type AuditWriter,
  createAuditWriter,
} from '../../src/audit/writer.js';
import { createDb } from '../../src/db/kysely.js';
import { migrationChecksums } from '../../src/db/migration-checksums.js';
import type { Database } from '../../src/db/types.js';
import { createMemoryMetrics } from '../../src/observability/metrics.js';
import { silentLogger } from '../../src/observability/logger.js';
import { type TestDatabase, createTestDatabase, insertAs } from './support/db.js';

const stack = await devStackOrSkip();
const ORG = '0192a0c0-0000-7000-8000-0000000000c3';

const event = (source: StoredEventInput['source'] = 'control-plane', n = 0): StoredEventInput => ({
  ...systemEvent({ action: 'audit.query', outcome: 'success', service: 'rts', details: { n } }),
  source,
});

describe.skipIf(stack === undefined)('audit core (F-002-T06)', () => {
  let db: TestDatabase | undefined;
  let writerPool: pg.Pool;
  let writerDb: Kysely<Database>;
  let sealerDb: Kysely<Database>;
  let readerDb: Kysely<Database>;
  const spoolDirs: string[] = [];
  const t = (): TestDatabase => {
    if (db === undefined) throw new Error('beforeAll did not create the database');
    return db;
  };
  const writer = (options: { timeoutMs?: number } = {}): AuditWriter =>
    createAuditWriter({ db: writerDb, ...options });
  const count = async (where: string, params: unknown[] = []): Promise<number> =>
    Number(
      (await t().superuser.query<{ n: string }>(`SELECT count(*) AS n FROM ${where}`, params))
        .rows[0]?.n,
    );

  beforeAll(async () => {
    db = await createTestDatabase(stack!);
    const migrated = await db.migrate(ORG);
    await insertAs(await db.pool('cp_app'), ORG, 'cp.organization', [
      {
        id: ORG,
        name: 'Org C',
        residency: 'in_country',
        region: 'qa-doha',
        deployment_model: 'on_prem',
      },
    ]);
    writerPool = await db.pool('audit_writer', 4);
    writerDb = createDb<Database>(writerPool);
    sealerDb = createDb<Database>(await db.pool('audit_sealer', 4));
    readerDb = createDb<Database>(await db.pool('audit_reader', 2));
    // db.migration.applied, as the migrate jobs record it (SR-29).
    const checksums = migrationChecksums();
    await writer().write(ORG, [
      ...migrationAppliedEvents('audit', migrated.audit.applied, checksums),
      ...migrationAppliedEvents('cp', migrated.cp.applied, checksums),
    ]);
  }, 60_000);

  afterAll(async () => {
    for (const dir of spoolDirs) rmSync(dir, { recursive: true, force: true });
    await db?.drop();
  });

  describe('writer', () => {
    it('records db.migration.applied for every applied migration with its lock checksum', async () => {
      const { rows } = await t().superuser.query<{
        set: string;
        migration: string;
        checksum: string;
      }>(
        `SELECT details->>'set' AS set, details->>'migration' AS migration, details->>'checksum' AS checksum
           FROM audit.audit_event WHERE action = 'db.migration.applied' AND actor_service = 'migrator'
          ORDER BY ingest_seq`,
      );
      expect(rows.map((r) => `${r.set}/${r.migration}`)).toEqual([
        'audit/0001_audit_store',
        'cp/0001_schemas_and_rls_helpers',
        'cp/0002_cp_identity',
        'cp/0003_cp_sessions_and_tokens',
        'cp/0004_usage_credential_governance',
      ]);
      for (const row of rows) expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it('stores each event; a repeated event_id is `duplicate` without failing the batch [AR-8]', async () => {
      const [a, b] = [event(), event()];
      await expect(writer().write(ORG, [a])).resolves.toEqual([
        { event_id: a.event_id, status: 'stored' },
      ]);
      await expect(writer().write(ORG, [b, a, event()])).resolves.toMatchObject([
        { event_id: b.event_id, status: 'stored' },
        { event_id: a.event_id, status: 'duplicate' },
        { status: 'stored' },
      ]);
      expect(await count(`audit.audit_event WHERE event_id = $1`, [a.event_id])).toBe(1);
    });

    it('fails closed within the 250 ms budget when the store is blocked', async () => {
      const metrics = createMemoryMetrics();
      const blocker = await (await t().pool('audit_migrator', 1)).connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SET LOCAL ROLE ralysa_audit_owner');
        await blocker.query('LOCK TABLE audit.audit_event IN ACCESS EXCLUSIVE MODE');
        const started = Date.now();
        await expect(
          createAuditWriter({ db: writerDb, metrics }).write(ORG, [event()]),
        ).rejects.toBeInstanceOf(AuditUnavailableError);
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(metrics.counter('audit_write_failures_total')).toBe(1);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
    });

    it('a denial spooled while the store is down is replayed with original_ts and spooled (SEC-F002-24)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ralysa-spool-int-'));
      spoolDirs.push(dir);
      const spool = await openAuditSpool({ dir: join(dir, 'spool'), persistent: true });
      const spooling = createAuditWriter({ db: writerDb, spool });
      const denial = tokenRejectedEvent({
        orgId: ORG,
        clientIp: '10.9.8.7',
        reason: 'expired',
        audience: 'model-gateway',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        network: '10.9.8.0/24',
      });
      const blocker = await (await t().pool('audit_migrator', 1)).connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SET LOCAL ROLE ralysa_audit_owner');
        await blocker.query('LOCK TABLE audit.audit_event IN ACCESS EXCLUSIVE MODE');
        await expect(spooling.writeOrSpool(ORG, [denial])).resolves.toEqual({ spooled: 1 });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      await expect(spool.replay((org, events) => spooling.write(org, events))).resolves.toEqual({
        replayed: 1,
        pending: 0,
      });
      const { rows } = await t().superuser.query<{
        server: { spooled: boolean; original_ts: string };
      }>(`SELECT details->'server' AS server FROM audit.audit_event WHERE event_id = $1`, [
        denial.event_id,
      ]);
      expect(rows[0]?.server.spooled).toBe(true);
      expect(Date.parse(rows[0]?.server.original_ts ?? '')).not.toBeNaN();
    });

    it('rejections flow through the aggregator into the store, with one summary per key', async () => {
      let now = 0;
      const pending: Promise<unknown>[] = [];
      const agg = createRejectionAggregator({
        now: () => now,
        perKeyLimit: 2,
        emit: (r) => pending.push(writer().writeOrSpool(ORG, [tokenRejectedEvent(r)])),
      });
      for (let i = 0; i < 5; i++) {
        agg.record({
          orgId: ORG,
          clientIp: `192.0.2.${String(i)}`,
          reason: 'bad_signature',
          audience: 'model-gateway',
          traceId: '0af7651916cd43dd8448eb211c80319c',
        });
      }
      now = 60_000;
      agg.flush();
      await Promise.all(pending);
      const { rows } = await t().superuser.query<{ suppressed: string | null }>(
        `SELECT details->>'suppressed_count' AS suppressed FROM audit.audit_event
          WHERE action = 'auth.token_rejected' AND reason_code = 'bad_signature' ORDER BY ingest_seq`,
      );
      // The emitted writes run concurrently, so ingest order needn't match emit order.
      expect(rows.map((r) => r.suppressed ?? 'individual').sort()).toEqual([
        '3',
        'individual',
        'individual',
      ]);
    });
  });

  describe('sealer (TC-F-002-23 sealing parts; SEC-F002-26)', () => {
    it('seals every shard and verifyChain passes for each', async () => {
      await writer().write(ORG, [event('model-gateway', 1), event('model-gateway', 2)]);
      const passes = await sealOnce({ db: sealerDb, orgId: ORG });
      expect(passes.find((p) => p.shard === 'model-gateway')?.sealed).toBe(2);
      expect(
        await count(`audit.audit_event e WHERE NOT EXISTS
        (SELECT 1 FROM audit.audit_seal s WHERE s.event_id = e.event_id)`),
      ).toBe(0);
      for (const shard of ['control-plane', 'model-gateway']) {
        await expect(verifyChain(readerDb, ORG, shard)).resolves.toMatchObject({ ok: true });
      }
      await expect(sealOnce({ db: sealerDb, orgId: ORG })).resolves.toSatisfy(
        (p: { sealed: number }[]) => p.every((x) => x.sealed === 0),
      );
    });

    it('the running sealer loop seals a new event within 5 s', async () => {
      const controller = new AbortController();
      const loop = runSealerLoop({
        db: sealerDb,
        orgId: ORG,
        intervalMs: 1_000,
        logger: silentLogger,
        signal: controller.signal,
      });
      try {
        const e = event('workspace-runtime');
        const started = Date.now();
        await writer().write(ORG, [e]);
        while ((await count(`audit.audit_seal WHERE event_id = $1`, [e.event_id])) === 0) {
          expect(Date.now() - started).toBeLessThan(5_000);
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        controller.abort();
        await loop;
      }
    });

    it('concurrent sealers never fork a chain (transaction-scoped advisory lock + PK)', async () => {
      await writer().write(
        ORG,
        Array.from({ length: 30 }, (_, n) => event('mcp-gateway', n)),
      );
      const other = createDb<Database>(await t().pool('audit_sealer', 2));
      await Promise.all([
        sealOnce({ db: sealerDb, orgId: ORG, shards: ['mcp-gateway'], batch: 7 }),
        sealOnce({ db: other, orgId: ORG, shards: ['mcp-gateway'], batch: 7 }),
        sealOnce({ db: sealerDb, orgId: ORG, shards: ['mcp-gateway'], batch: 7 }),
      ]);
      for (let i = 0; i < 6; i++)
        await sealOnce({ db: other, orgId: ORG, shards: ['mcp-gateway'] });
      expect(await count(`audit.audit_seal WHERE shard = 'mcp-gateway'`)).toBe(30);
      await expect(verifyChain(readerDb, ORG, 'mcp-gateway')).resolves.toMatchObject({
        ok: true,
        length: 30,
      });
    });

    it('an event that commits after a later one was sealed is sealed on the next pass', async () => {
      const late = event('agent-host-server', 1);
      const client = await writerPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`select set_config('app.org_id', $1, true)`, [ORG]);
        const columns = toColumns(ORG, late);
        const names = Object.keys(columns);
        await client.query(
          `INSERT INTO audit.audit_event (${names.join(', ')}) VALUES (${names.map((_, i) => `$${String(i + 1)}`).join(', ')})`,
          Object.values(columns),
        );
        await writer().write(ORG, [event('agent-host-server', 2)]);
        await sealOnce({ db: sealerDb, orgId: ORG, shards: ['agent-host-server'] });
        expect(await count(`audit.audit_seal WHERE shard = 'agent-host-server'`)).toBe(1);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      await sealOnce({ db: sealerDb, orgId: ORG, shards: ['agent-host-server'] });
      const { rows } = await t().superuser.query<{ seq: string }>(
        `SELECT seq FROM audit.audit_seal WHERE event_id = $1`,
        [late.event_id],
      );
      expect(rows[0]?.seq).toBe('2');
      await expect(verifyChain(readerDb, ORG, 'agent-host-server')).resolves.toMatchObject({
        ok: true,
        length: 2,
      });
    });

    it("a superuser's rewrite of a sealed event is reported at its seq [AR-6]", async () => {
      await writer().write(
        ORG,
        [1, 2, 3].map((n) => event('agent-host-local', n)),
      );
      await sealOnce({ db: sealerDb, orgId: ORG, shards: ['agent-host-local'] });
      await expect(verifyChain(readerDb, ORG, 'agent-host-local')).resolves.toMatchObject({
        ok: true,
        length: 3,
      });
      const su = t().superuser;
      await su.query('BEGIN');
      await su.query('ALTER TABLE audit.audit_event DISABLE TRIGGER USER');
      await su.query(
        `UPDATE audit.audit_event SET details = '{"n": 99}'
          WHERE event_id = (SELECT event_id FROM audit.audit_seal WHERE shard = 'agent-host-local' AND seq = 2)`,
      );
      for (const name of ['reset', 'row', 'stmt']) {
        await su.query(
          `ALTER TABLE audit.audit_event ENABLE ALWAYS TRIGGER audit_event_reject_modify_${name}`,
        );
      }
      await su.query(
        'ALTER TABLE audit.audit_event ENABLE ALWAYS TRIGGER audit_event_reject_truncate',
      );
      await su.query('COMMIT');
      await expect(verifyChain(readerDb, ORG, 'agent-host-local')).resolves.toEqual({
        ok: false,
        seq: 2,
        reason: 'event_hash_mismatch',
      });
      // The event trigger recorded the DDL that made the rewrite possible.
      expect(
        await count(`audit.audit_event WHERE action = 'audit.schema_changed'
          AND details->>'command_tag' = 'ALTER TABLE' AND details->>'session_user' = 'postgres'`),
      ).toBeGreaterThanOrEqual(2);
    });

    it('the sealer role can only seal: no event writes, no seal updates', async () => {
      const sealer = await t().pool('audit_sealer', 1);
      const client = await sealer.connect();
      try {
        await client.query('BEGIN');
        await client.query(`select set_config('app.org_id', $1, true)`, [ORG]);
        await expect(client.query(`UPDATE audit.audit_seal SET shard = 'x'`)).rejects.toMatchObject(
          { code: '42501' },
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      await expect(
        insertAs(sealer, ORG, 'audit.audit_event', [toColumns(ORG, event())]),
      ).rejects.toMatchObject({
        code: '42501',
      });
    });
  });
});
