// audit.record_custody_violation() (audit/0002; security review of T16-1, SEC-F002-34 §B):
// tests T1–T7 and T11 (T8 is the dev-stack policy test, T9 the config test, T10 the checkpoint
// integration test).
import { devStackOrSkip } from '@ralysa/dev-stack/harness';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toColumns } from '../../src/audit/columns.js';
import { systemEvent } from '../../src/audit/events.js';
import { type TestDatabase, createTestDatabase, insertAs, sqlState } from './support/db.js';

const stack = await devStackOrSkip();
const ORG = '0192a0c0-0000-7000-8000-0000000000e5';
const KEY = 'ralysa-audit-checkpoint';
const FN = 'audit.record_custody_violation(text, boolean, boolean)';

describe.skipIf(stack === undefined)('audit.record_custody_violation (SEC-F002-34)', () => {
  let db: TestDatabase | undefined;
  let sealer: pg.Pool;
  const t = (): TestDatabase => {
    if (db === undefined) throw new Error('beforeAll did not create the database');
    return db;
  };

  /** Calls the function as `pool`'s role, optionally inside an org scope. */
  const call = async (
    pool: pg.Pool,
    args: [unknown, unknown, unknown],
    orgId: string | null = ORG,
  ): Promise<boolean> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (orgId !== null) await client.query(`select set_config('app.org_id', $1, true)`, [orgId]);
      const { rows } = await client.query<{ recorded: boolean }>(
        'select audit.record_custody_violation($1, $2, $3) as recorded',
        args,
      );
      await client.query('COMMIT');
      return rows[0]?.recorded === true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  const rows = async () =>
    (
      await t().superuser.query<Record<string, unknown>>(
        `SELECT org_id, actor_type, actor_user_id, actor_idp_subject, actor_service, outcome,
                reason_code, source, attestation, trace_id, event_id, details
           FROM audit.audit_event WHERE action = 'secret.custody_violation' ORDER BY ingest_seq`,
      )
    ).rows;

  beforeAll(async () => {
    db = await createTestDatabase(stack!);
    await db.migrate(ORG);
    sealer = await db.pool('audit_sealer', 3);
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('T11: applying audit/0002 wrote audit.schema_changed for the new function', async () => {
    const { rows: changed } = await t().superuser.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.audit_event WHERE action = 'audit.schema_changed'
          AND details->>'command_tag' = 'CREATE FUNCTION'
          AND details->>'object_identity' LIKE 'audit.record_custody_violation(%'`,
    );
    expect(Number(changed[0]?.n)).toBe(1);
  });

  it('T6: SECURITY DEFINER, search_path pg_catalog then pg_temp, owned by the NOLOGIN audit owner', async () => {
    const { rows: proc } = await t().superuser.query<{
      definer: boolean;
      config: string[];
      owner: string;
    }>(
      `SELECT p.prosecdef AS definer, p.proconfig AS config, pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'audit' AND p.proname = 'record_custody_violation'`,
    );
    expect(proc).toEqual([
      { definer: true, config: ['search_path=pg_catalog, pg_temp'], owner: 'ralysa_audit_owner' },
    ]);
  });

  it('T4: only the sealer may execute it', async () => {
    const { rows: pub } = await t().superuser.query<{ allowed: boolean }>(
      `SELECT has_function_privilege('public', '${FN}', 'EXECUTE') AS allowed`,
    );
    expect(pub[0]?.allowed).toBe(false);
    for (const key of ['audit_writer', 'audit_reader', 'cp_app', 'migrator'] as const) {
      const pool = await t().pool(key, 1);
      expect(await sqlState(call(pool, [KEY, true, false]))).toBe('42501');
    }
    expect(await rows()).toEqual([]);
  });

  it('T5: without app.org_id it fails with 42704 (current_org(): parameter unset) and writes nothing', async () => {
    // A fresh connection: on a pooled one where app.org_id was set transaction-locally before,
    // the placeholder remains as '' and the uuid cast raises 22P02 instead. Both fail closed.
    const fresh = await t().pool('audit_sealer', 1);
    expect(await sqlState(call(fresh, [KEY, true, false], null))).toBe('42704');
    expect(await rows()).toEqual([]);
  });

  it.each([
    ['another key', ['ralysa-rts-signing', true, false]],
    ['an empty key', ['', true, false]],
    ['a NULL key', [null, true, false]],
    ['a 200-character key', ['k'.repeat(200), true, false]],
    ['an injection-shaped key', ["x'; drop table audit.audit_event; --", true, false]],
    ['both flags false', [KEY, false, false]],
    ['a NULL flag', [KEY, null, true]],
  ] as const)('T2: %s is refused with 22023 and no row', async (_name, args) => {
    expect(await sqlState(call(sealer, [...args]))).toBe('22023');
    expect(await rows()).toEqual([]);
  });

  it('T1: the sealer records exactly one row with every field fixed by the function (B5, B6)', async () => {
    await expect(call(sealer, [KEY, true, false])).resolves.toBe(true);
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      org_id: ORG,
      actor_type: 'system',
      actor_user_id: null,
      actor_idp_subject: null,
      actor_service: 'sealer',
      outcome: 'error',
      reason_code: 'exportable',
      source: 'control-plane',
      attestation: 'server',
      details: {
        key: KEY,
        exportable: true,
        allow_plaintext_backup: false,
        flag: 'exportable',
        db_role: 'ralysa_audit_sealer',
        via: 'audit.record_custody_violation',
      },
    });
    expect(row?.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.event_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('T3: a repeat within 5 minutes is suppressed; another flag pair is a new row; concurrent calls record once', async () => {
    await expect(call(sealer, [KEY, true, false])).resolves.toBe(false);
    expect(await rows()).toHaveLength(1);
    await expect(call(sealer, [KEY, false, true])).resolves.toBe(true);
    expect(await rows()).toHaveLength(2);
    const results = await Promise.all([
      call(sealer, [KEY, true, true]),
      call(sealer, [KEY, true, true]),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await rows()).toHaveLength(3);
    expect((await rows()).at(-1)).toMatchObject({
      reason_code: 'exportable',
      details: { allow_plaintext_backup: true },
    });
  });

  it('T7: the sealer still cannot insert events directly', async () => {
    const event = {
      ...systemEvent({ action: 'audit.query', outcome: 'success', service: 'x', details: {} }),
      source: 'control-plane' as const,
    };
    expect(
      await sqlState(insertAs(sealer, ORG, 'audit.audit_event', [toColumns(ORG, event)])),
    ).toBe('42501');
  });
});
