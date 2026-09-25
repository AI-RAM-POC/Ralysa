// F-002-T16: TC-F-002-29 and the sealer part of TC-F-002-33, against the dev stack (Postgres and
// OpenBao Transit). A throwaway checkpoint key per run, so flipping its flags can't affect the
// real ralysa-audit-checkpoint.
//   - the running sealer checkpoints (test interval 2 s); signatures verify; the log line equals
//     the row; audit-verify is clean;
//   - a stopped sealer → checkpoint_gap;
//   - the audit OWNER rewrites an event and recomputes every later seal → the stored chain looks
//     consistent, but audit-verify fails at the first checkpoint covering that seq;
//   - deleting the newest checkpoint rows → detected with the logged checkpoints;
//   - flipping `exportable` on the checkpoint key at runtime → signing stops and
//     secret.custody_violation is written.
import { GENESIS_PREV_HASH, chainHash, type Source } from '@ralysa/protocol/audit';
import { createOpenBao, type KeyCustody, type PublicJwk } from '@ralysa/secrets';
import { devStackOrSkip, expectOk, rootBao, uniqueName } from '@ralysa/dev-stack/harness';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredEventInput } from '../../src/audit/columns.js';
import { systemEvent } from '../../src/audit/events.js';
import {
  type AuditEventRow,
  readSeals,
  rowEventHash,
  verifyChain,
} from '../../src/audit/sealer/chain.js';
import {
  type CheckpointRecord,
  type CheckpointSigner,
  checkpointOnce,
  createCheckpointSigner,
} from '../../src/audit/sealer/checkpoint.js';
import { runSealerLoop, sealOnce } from '../../src/audit/sealer/sealer.js';
import { auditVerify, parseCheckpointLog } from '../../src/audit/verify/audit-verify.js';
import { createAuditWriter } from '../../src/audit/writer.js';
import { createDb } from '../../src/db/kysely.js';
import type { Database } from '../../src/db/types.js';
import { type Logger, createJsonLogger, silentLogger } from '../../src/observability/logger.js';
import { type TestDatabase, createTestDatabase, insertAs } from './support/db.js';

const stack = await devStackOrSkip();
const ORG = '0192a0c0-0000-7000-8000-0000000000d4';
const SHARD = 'control-plane';

const event = (n: number, source: Source = SHARD): StoredEventInput => ({
  ...systemEvent({ action: 'audit.query', outcome: 'success', service: 'rts', details: { n } }),
  source,
});

describe.skipIf(stack === undefined)(
  'checkpoints and audit-verify (F-002-T16, TC-F-002-29)',
  () => {
    let db: TestDatabase | undefined;
    let custody: KeyCustody;
    let signer: CheckpointSigner;
    let sealerDb: Kysely<Database>;
    let readerDb: Kysely<Database>;
    let writerDb: Kysely<Database>;
    const key = uniqueName('ralysa-test-t16-ckpt');
    const logLines: string[] = [];
    const logger: Logger = createJsonLogger((line) => logLines.push(line));
    const t = (): TestDatabase => {
      if (db === undefined) throw new Error('beforeAll did not create the database');
      return db;
    };
    const publicKeys = async (): Promise<Map<number, PublicJwk>> =>
      new Map((await custody.describe(key)).versions.map((v) => [v.version, v.jwk]));
    const verify = async (options: { now?: Date; logCheckpoints?: CheckpointRecord[] } = {}) =>
      auditVerify({
        db: readerDb,
        orgId: ORG,
        shards: [SHARD],
        publicKeys: await publicKeys(),
        ...options,
      });

    beforeAll(async () => {
      expectOk(await rootBao(stack!)('POST', `transit/keys/${key}`, { type: 'ecdsa-p256' }), 'key');
      custody = createOpenBao({
        addr: stack!.openbao.addr,
        auth: { method: 'token', token: stack!.openbao.rootToken },
        env: 'test',
      }).keys;
      db = await createTestDatabase(stack!);
      await db.migrate(ORG);
      await insertAs(await db.pool('cp_app'), ORG, 'cp.organization', [
        {
          id: ORG,
          name: 'Org D',
          residency: 'in_country',
          region: 'qa-doha',
          deployment_model: 'on_prem',
        },
      ]);
      sealerDb = createDb<Database>(await db.pool('audit_sealer', 3));
      readerDb = createDb<Database>(await db.pool('audit_reader', 2));
      writerDb = createDb<Database>(await db.pool('audit_writer', 2));
      signer = createCheckpointSigner({
        custody,
        key,
        orgId: ORG,
        writer: createAuditWriter({ db: writerDb }),
        logger,
      });
    }, 60_000);

    afterAll(async () => {
      const root = rootBao(stack!);
      await root('POST', `transit/keys/${key}/config`, { deletion_allowed: true });
      await root('DELETE', `transit/keys/${key}`);
      await db?.drop();
    });

    it('the running sealer writes signed checkpoints; the log line equals the row; audit-verify is clean', async () => {
      await createAuditWriter({ db: writerDb }).write(ORG, [event(1), event(2), event(3)]);
      const controller = new AbortController();
      const loop = runSealerLoop({
        db: sealerDb,
        orgId: ORG,
        shards: [SHARD],
        intervalMs: 200,
        logger,
        signal: controller.signal,
        checkpoints: { signer, intervalMs: 2_000, custodyPollMs: 500 },
      });
      try {
        const started = Date.now();
        await createAuditWriter({ db: writerDb }).write(ORG, [event(4)]);
        // First checkpoint right away, a second one ≥ 2 s later covering the new event.
        for (;;) {
          const rows = parseCheckpointLog(logLines.join(''));
          if (rows.length >= 1 && Date.now() - started > 2_500) break;
          expect(Date.now() - started).toBeLessThan(10_000);
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        controller.abort();
        await loop;
      }
      const logged = parseCheckpointLog(logLines.join(''));
      const { rows } = await t().superuser.query<{
        seq: string;
        hash: Buffer;
        checkpoint_ts: Date;
        key_version: number;
        signature: Buffer;
      }>(
        `SELECT seq, hash, checkpoint_ts, key_version, signature FROM audit.audit_checkpoint WHERE shard = $1 ORDER BY seq`,
        [SHARD],
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(logged).toEqual(
        rows.map((r) => ({
          org_id: ORG,
          shard: SHARD,
          seq: Number(r.seq),
          hash: r.hash.toString('hex'),
          checkpoint_ts: r.checkpoint_ts.toISOString(),
          key_version: r.key_version,
          signature: r.signature.toString('base64url'),
        })),
      );
      const head = (await readSeals(readerDb, ORG, SHARD)).at(-1);
      expect(Number(rows.at(-1)?.seq)).toBe(head?.seq);
      await expect(verify({ logCheckpoints: logged })).resolves.toMatchObject({ findings: [] });
    });

    it('a stopped sealer is reported as checkpoint_gap', async () => {
      await createAuditWriter({ db: writerDb }).write(ORG, [event(5)]);
      await sealOnce({ db: sealerDb, orgId: ORG, shards: [SHARD] }); // sealed, not checkpointed
      const seq = (await readSeals(readerDb, ORG, SHARD)).at(-1)?.seq;
      const { findings } = await verify({ now: new Date(Date.now() + 121_000) });
      expect(findings).toContainEqual(
        expect.objectContaining({ kind: 'checkpoint_gap', shard: SHARD, seq }),
      );
      // Once checkpointed again, the gap is closed.
      await checkpointOnce({ db: sealerDb, orgId: ORG, shards: [SHARD], signer, logger });
      await expect(verify({ now: new Date(Date.now() + 121_000) })).resolves.toMatchObject({
        findings: [],
      });
    });

    it("the audit owner's rewrite with recomputed seals is caught at the first checkpoint covering it [SEC-F002-01 c]", async () => {
      const checkpointSeqs = (
        await t().superuser.query<{ seq: string }>(
          `SELECT seq FROM audit.audit_checkpoint WHERE shard = $1 ORDER BY seq`,
          [SHARD],
        )
      ).rows.map((r) => Number(r.seq));
      const target = 2;
      const owner = await (await t().pool('audit_migrator', 1)).connect();
      try {
        await owner.query('SET ROLE ralysa_audit_owner');
        await owner.query('BEGIN');
        await owner.query(`select set_config('app.org_id', $1, true)`, [ORG]);
        for (const table of ['audit_event', 'audit_seal']) {
          await owner.query(`ALTER TABLE audit.${table} DISABLE TRIGGER USER`);
        }
        await owner.query(
          `UPDATE audit.audit_event SET details = '{"n": 999}'
          WHERE event_id = (SELECT event_id FROM audit.audit_seal WHERE shard = $1 AND seq = $2)`,
          [SHARD, target],
        );
        // Recompute every seal from genesis, as an attacker with the owner role can.
        const { rows } = await owner.query<AuditEventRow & { seal_seq: string }>(
          `SELECT e.*, s.seq AS seal_seq FROM audit.audit_seal s JOIN audit.audit_event e USING (event_id)
          WHERE s.shard = $1 ORDER BY s.seq`,
          [SHARD],
        );
        let prev = GENESIS_PREV_HASH;
        for (const row of rows) {
          const eventHashValue = await rowEventHash(row);
          const hash = await chainHash(prev, eventHashValue);
          await owner.query(
            `UPDATE audit.audit_seal SET event_hash = $1, prev_hash = $2, hash = $3 WHERE shard = $4 AND seq = $5`,
            [eventHashValue, prev, hash, SHARD, row.seal_seq],
          );
          prev = hash;
        }
        for (const table of ['audit_event', 'audit_seal']) {
          for (const name of ['reset', 'row', 'stmt']) {
            await owner.query(
              `ALTER TABLE audit.${table} ENABLE ALWAYS TRIGGER ${table}_reject_modify_${name}`,
            );
          }
        }
        await owner.query('COMMIT');
      } finally {
        await owner.query('RESET ROLE');
        owner.release();
      }
      // The stored chain is self-consistent after the recompute …
      await expect(verifyChain(readerDb, ORG, SHARD)).resolves.toMatchObject({ ok: true });
      // … but the signed checkpoints disagree from the first one covering the rewritten seq.
      const firstCovering = checkpointSeqs.find((seq) => seq >= target);
      const result = await verify();
      expect(result.findings).toContainEqual({
        kind: 'checkpoint_mismatch',
        shard: SHARD,
        seq: firstCovering,
      });
      expect(result.findings.some((f) => f.kind === 'checkpoint_mismatch' && f.seq < target)).toBe(
        false,
      );
      expect(result.shards[0]?.firstDivergentSeq).toBe(firstCovering);
    });

    it('deleted checkpoint rows are detected against the logged checkpoints [SEC-F002-01 d]', async () => {
      const logged = parseCheckpointLog(logLines.join(''));
      const newest = Math.max(...logged.map((r) => r.seq));
      const owner = await (await t().pool('audit_migrator', 1)).connect();
      try {
        await owner.query('SET ROLE ralysa_audit_owner');
        await owner.query('BEGIN');
        await owner.query(`select set_config('app.org_id', $1, true)`, [ORG]);
        await owner.query('ALTER TABLE audit.audit_checkpoint DISABLE TRIGGER USER');
        await owner.query(`DELETE FROM audit.audit_checkpoint WHERE shard = $1 AND seq = $2`, [
          SHARD,
          newest,
        ]);
        for (const name of ['reset', 'row', 'stmt']) {
          await owner.query(
            `ALTER TABLE audit.audit_checkpoint ENABLE ALWAYS TRIGGER audit_checkpoint_reject_modify_${name}`,
          );
        }
        await owner.query('COMMIT');
      } finally {
        await owner.query('RESET ROLE');
        owner.release();
      }
      const withoutLog = await verify();
      expect(withoutLog.findings.some((f) => f.kind === 'checkpoint_missing')).toBe(false);
      const withLog = await verify({ logCheckpoints: logged });
      expect(withLog.findings).toContainEqual({
        kind: 'checkpoint_missing',
        shard: SHARD,
        seq: newest,
      });
    });

    it('flipping exportable on the checkpoint key stops signing and writes secret.custody_violation (TC-F-002-33)', async () => {
      expectOk(
        await rootBao(stack!)('POST', `transit/keys/${key}/config`, { exportable: true }),
        'flip',
      );
      await expect(signer.poll()).resolves.toBe(false);
      expect(signer.healthy()).toBe(false);
      await createAuditWriter({ db: writerDb }).write(ORG, [event(6)]);
      await sealOnce({ db: sealerDb, orgId: ORG, shards: [SHARD] });
      await expect(
        checkpointOnce({ db: sealerDb, orgId: ORG, shards: [SHARD], signer, logger: silentLogger }),
      ).resolves.toEqual([]);
      const { rows } = await t().superuser.query<{ key: string; flag: string; service: string }>(
        `SELECT details->>'key' AS key, details->>'flag' AS flag, actor_service AS service
         FROM audit.audit_event WHERE action = 'secret.custody_violation'`,
      );
      expect(rows).toEqual([{ key, flag: 'exportable', service: 'sealer' }]);
    });
  },
);
