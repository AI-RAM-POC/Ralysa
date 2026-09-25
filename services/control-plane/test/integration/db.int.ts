// F-002-T05 against the dev-stack Postgres: TC-F-002-19 (schema, org_id, FORCE RLS, regions),
// TC-F-002-23's grant, trigger, seal-table and DDL-trigger parts (the sealing and verifyChain
// parts are T06), TC-F-002-27 (org isolation and pool hygiene), migrate-twice no-op, UTF-8
// refusals and the role layout of SEC-F002-01 a / -25.
import { randomBytes } from 'node:crypto';
import { devStackOrSkip } from '@ralysa/dev-stack/harness';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withOrg } from '../../src/db/kysely.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Database } from '../../src/db/types.js';
import {
  type TestDatabase,
  auditRow,
  createTestDatabase,
  insertAs,
  sqlState,
} from './support/db.js';

const stack = await devStackOrSkip();

const ORG_A = '0192a0c0-0000-7000-8000-0000000000a1';
const ORG_B = '0192a0c0-0000-7000-8000-0000000000b2';
const CP_TABLES = [
  'app_user',
  'auth_session',
  'authorization_code',
  'client_assertion_replay',
  'client_audit_cursor',
  'credential',
  'group_membership',
  'idp_auth_request',
  'idp_group',
  'idp_token_replay',
  'kill_switch',
  'organization',
  'refresh_token',
  'signing_key_version',
  'usage_record',
];
const AUDIT_TABLES = ['audit_checkpoint', 'audit_event', 'audit_seal'];

describe.skipIf(stack === undefined)('database (F-002-T05)', () => {
  let db: TestDatabase | undefined;
  const t = (): TestDatabase => {
    if (db === undefined) throw new Error('beforeAll did not create the database');
    return db;
  };

  beforeAll(async () => {
    db = await createTestDatabase(stack!);
    const first = await db.migrate(ORG_A);
    expect(first.audit.applied).toEqual(['0001_audit_store']);
    expect(first.cp.applied).toEqual([
      '0001_schemas_and_rls_helpers',
      '0002_cp_identity',
      '0003_cp_sessions_and_tokens',
      '0004_usage_credential_governance',
    ]);
    // Two organizations, inserted by the app role inside each org's scope.
    const app = await db.pool('cp_app');
    for (const [id, region] of [
      [ORG_A, 'qa-doha'],
      [ORG_B, 'ae-dubai'],
    ] as const) {
      await insertAs(app, id, 'cp.organization', [
        {
          id,
          name: `Org ${id.slice(-2)}`,
          residency: 'in_country',
          region,
          deployment_model: 'on_prem',
        },
      ]);
    }
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('schema (TC-F-002-19)', () => {
    it('migrating twice is a no-op', async () => {
      const again = await t().migrate(ORG_A);
      expect(again).toEqual({
        audit: { set: 'audit', applied: [] },
        cp: { set: 'cp', applied: [] },
      });
    });

    it('every cp and audit table has org_id, RLS enabled and forced; history schemas excluded', async () => {
      const { rows } = await t().superuser.query<{
        schema: string;
        name: string;
        rls: boolean;
        force: boolean;
        has_org: boolean;
      }>(`
        SELECT n.nspname AS schema, c.relname AS name, c.relrowsecurity AS rls,
               c.relforcerowsecurity AS force,
               EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                       AND a.attname = 'org_id' AND NOT a.attisdropped) AS has_org
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('cp', 'audit')
         ORDER BY 1, 2`);
      expect(rows.filter((r) => r.schema === 'cp').map((r) => r.name)).toEqual(CP_TABLES);
      expect(rows.filter((r) => r.schema === 'audit').map((r) => r.name)).toEqual(AUDIT_TABLES);
      for (const row of rows) expect(row).toMatchObject({ rls: true, force: true, has_org: true });
      const meta = await t().superuser.query<{ schema: string }>(
        `SELECT DISTINCT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname LIKE 'ralysa_meta%' AND c.relkind = 'r' ORDER BY 1`,
      );
      expect(meta.rows.map((r) => r.schema)).toEqual(['ralysa_meta', 'ralysa_meta_audit']);
    });

    it('endpoint_region and inference_region exist on usage_record and audit_event (AC-13)', async () => {
      const { rows } = await t().superuser.query<{ t: string; c: string }>(`
        SELECT table_schema || '.' || table_name AS t, column_name AS c FROM information_schema.columns
         WHERE column_name IN ('endpoint_region', 'inference_region')
           AND table_schema IN ('cp', 'audit') ORDER BY 1, 2`);
      expect(rows).toEqual([
        { t: 'audit.audit_event', c: 'endpoint_region' },
        { t: 'audit.audit_event', c: 'inference_region' },
        { t: 'cp.usage_record', c: 'endpoint_region' },
        { t: 'cp.usage_record', c: 'inference_region' },
      ]);
    });

    it('the NOLOGIN audit owner owns the audit store; the cp migrator owns cp and is no member of it', async () => {
      const { rows } = await t().superuser.query<{ schema: string; owner: string }>(`
        SELECT DISTINCT n.nspname AS schema, pg_get_userbyid(c.relowner) AS owner
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('cp', 'audit', 'ralysa_meta', 'ralysa_meta_audit') ORDER BY 1`);
      expect(rows).toEqual([
        { schema: 'audit', owner: 'ralysa_audit_owner' },
        { schema: 'cp', owner: 'ralysa_migrator' },
        { schema: 'ralysa_meta', owner: 'ralysa_migrator' },
        { schema: 'ralysa_meta_audit', owner: 'ralysa_audit_owner' },
      ]);
      const roles = await t().superuser.query<Record<string, boolean>>(`
        SELECT pg_has_role('ralysa_migrator', 'ralysa_audit_owner', 'MEMBER') AS migrator_member,
               pg_has_role('ralysa_audit_migrator', 'ralysa_audit_owner', 'USAGE') AS audit_migrator_inherits,
               pg_has_role('ralysa_audit_migrator', 'ralysa_audit_owner', 'SET') AS audit_migrator_can_set,
               (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'ralysa_audit_owner') AS owner_can_login`);
      expect(roles.rows[0]).toEqual({
        migrator_member: false,
        audit_migrator_inherits: false,
        audit_migrator_can_set: true,
        owner_can_login: false,
      });
    });

    it('bootstrap-roles.sql is idempotent', async () => {
      const { readFileSync } = await import('node:fs');
      const { BOOTSTRAP_ROLES_SQL } = await import('@ralysa/dev-stack/harness');
      await expect(
        t().superuser.query(readFileSync(BOOTSTRAP_ROLES_SQL, 'utf8')),
      ).resolves.toBeDefined();
    });

    it('no Ralysa role may set session_replication_role (SEC-F002-25)', async () => {
      for (const key of ['cp_app', 'audit_writer', 'migrator'] as const) {
        const pool = await t().pool(key, 1);
        expect(await sqlState(pool.query(`SET session_replication_role = replica`))).toBe('42501');
      }
    });
  });

  describe('insert-only audit store (TC-F-002-23: grants, triggers, seal table, DDL)', () => {
    let writer: pg.Pool;
    let sealer: pg.Pool;
    const events = [auditRow(ORG_A), auditRow(ORG_A), auditRow(ORG_A)];

    beforeAll(async () => {
      writer = await t().pool('audit_writer');
      sealer = await t().pool('audit_sealer');
      // The writer path through Kysely and withOrg, as the application will use it.
      const kdb = createDb<Database>(writer);
      await withOrg(kdb, ORG_A, async (trx) => {
        for (const event of events)
          await trx.insertInto('audit.audit_event').values(event).execute();
      });
      const hash = () => randomBytes(32);
      await insertAs(
        sealer,
        ORG_A,
        'audit.audit_seal',
        events.map((e, i) => ({
          org_id: ORG_A,
          shard: 'control-plane',
          seq: i + 1,
          event_id: e.event_id,
          event_hash: hash(),
          prev_hash: hash(),
          hash: hash(),
        })),
      );
      await insertAs(sealer, ORG_A, 'audit.audit_checkpoint', [
        {
          org_id: ORG_A,
          shard: 'control-plane',
          seq: 1,
          hash: hash(),
          checkpoint_ts: new Date(),
          key_version: 1,
          signature: hash(),
        },
        {
          org_id: ORG_A,
          shard: 'control-plane',
          seq: 3,
          hash: hash(),
          checkpoint_ts: new Date(),
          key_version: 1,
          signature: hash(),
        },
      ]);
    });

    it('the writer can insert but not read, update, delete, truncate or set server columns (42501)', async () => {
      const inTx = async (statement: string) => {
        const client = await writer.connect();
        try {
          await client.query('BEGIN');
          await client.query(`select set_config('app.org_id', $1, true)`, [ORG_A]);
          await client.query(statement);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      };
      expect(await sqlState(inTx(`SELECT 1 FROM audit.audit_event`))).toBe('42501');
      expect(await sqlState(inTx(`UPDATE audit.audit_event SET action = 'x.y'`))).toBe('42501');
      expect(await sqlState(inTx(`DELETE FROM audit.audit_event`))).toBe('42501');
      expect(await sqlState(inTx(`TRUNCATE audit.audit_event`))).toBe('42501');
      expect(
        await sqlState(
          insertAs(writer, ORG_A, 'audit.audit_event', [
            { ...auditRow(ORG_A), ts: new Date('2020-01-01') },
          ]),
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          insertAs(writer, ORG_A, 'audit.audit_event', [{ ...auditRow(ORG_A), schema_version: 9 }]),
        ),
      ).toBe('42501');
    });

    it('the writer cannot insert into another org (RLS WITH CHECK)', async () => {
      expect(await sqlState(insertAs(writer, ORG_A, 'audit.audit_event', [auditRow(ORG_B)]))).toBe(
        '42501',
      );
    });

    it('the cp migrator has no rights on the audit schema', async () => {
      const migrator = await t().pool('migrator', 1);
      expect(await sqlState(migrator.query(`SELECT 1 FROM audit.audit_event`))).toBe('42501');
      expect(await sqlState(migrator.query(`DROP TABLE audit.audit_seal`))).toBe('42501');
    });

    describe('as the audit owner (break-glass path)', () => {
      let owner: pg.PoolClient;
      beforeAll(async () => {
        const pool = await t().pool('audit_migrator', 1);
        owner = await pool.connect();
        // Test code: the break-glass job switches role the same way (src/db/migrate.ts).
        await owner.query('SET ROLE ralysa_audit_owner');
      });
      afterAll(() => {
        owner.release();
      });

      const denials = async (table: string, operation: string) => {
        const { rows } = await t().superuser.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit.audit_event WHERE action = 'audit.modify_denied'
             AND details->>'table' = $1 AND details->>'op' = $2 AND actor_service = 'audit-store' AND (details->>'row_count')::int = $3`,
          [table, operation, table === 'audit.audit_checkpoint' ? 2 : 3],
        );
        return Number(rows[0]?.n);
      };

      it.each([
        [
          'audit.audit_event',
          `UPDATE audit.audit_event SET action = 'tampered.x' WHERE org_id = '${ORG_A}' AND action = 'auth.sign_in'`,
          'UPDATE',
        ],
        [
          'audit.audit_event',
          `DELETE FROM audit.audit_event WHERE org_id = '${ORG_A}' AND action = 'auth.sign_in'`,
          'DELETE',
        ],
        [
          'audit.audit_seal',
          `UPDATE audit.audit_seal SET hash = '\\x00'::bytea || substring(hash from 2)`,
          'UPDATE',
        ],
        ['audit.audit_seal', `DELETE FROM audit.audit_seal`, 'DELETE'],
        ['audit.audit_checkpoint', `UPDATE audit.audit_checkpoint SET key_version = 2`, 'UPDATE'],
        ['audit.audit_checkpoint', `DELETE FROM audit.audit_checkpoint`, 'DELETE'],
      ])(
        '%s: a multi-row %s changes 0 rows and writes ONE audit.modify_denied; app.org_id is restored',
        async (table, statement, operation) => {
          const before = await denials(table, operation);
          await owner.query('BEGIN');
          await owner.query(`select set_config('app.org_id', $1, true)`, [ORG_A]);
          const result = await owner.query(statement);
          expect(result.rowCount).toBe(0);
          const org = await owner.query<{ org: string }>(
            `SELECT current_setting('app.org_id', true) AS org`,
          );
          expect(org.rows[0]?.org).toBe(ORG_A);
          await owner.query('COMMIT');
          expect(await denials(table, operation)).toBe(before + 1);
        },
      );

      // CASCADE gets past the audit_seal → audit_event foreign key (which alone refuses a plain
      // TRUNCATE of audit_event with 0A000), so the guard trigger itself is what refuses.
      it.each(AUDIT_TABLES)('TRUNCATE … CASCADE on audit.%s raises (42501)', async (table) => {
        expect(await sqlState(owner.query(`TRUNCATE audit.${table} CASCADE`))).toBe('42501');
      });

      it('ALTER TABLE … DISABLE TRIGGER writes audit.schema_changed (event trigger, SEC-F002-01 b)', async () => {
        const count = async () =>
          Number(
            (
              await t().superuser.query<{ n: string }>(
                `SELECT count(*) AS n FROM audit.audit_event WHERE action = 'audit.schema_changed'
                   AND details->>'command_tag' = 'ALTER TABLE' AND details->>'object_identity' = 'audit.audit_event'
                   AND details->>'session_user' = 'ralysa_audit_migrator' AND details->>'current_user' = 'ralysa_audit_owner'
                   AND org_id = $1`,
                [ORG_A],
              )
            ).rows[0]?.n,
          );
        const before = await count();
        await owner.query('BEGIN');
        await owner.query(`select set_config('app.org_id', $1, true)`, [ORG_A]);
        await owner.query(
          `ALTER TABLE audit.audit_event DISABLE TRIGGER audit_event_reject_modify_row`,
        );
        await owner.query(
          `ALTER TABLE audit.audit_event ENABLE ALWAYS TRIGGER audit_event_reject_modify_row`,
        );
        await owner.query('COMMIT');
        expect(await count()).toBe(before + 2);
      });

      it('the owner cannot touch the event trigger (superuser-owned)', async () => {
        expect(
          await sqlState(owner.query(`ALTER EVENT TRIGGER ralysa_audit_ddl_end DISABLE`)),
        ).toBe('42501');
      });
    });

    it('the rows are all still there, unchanged', async () => {
      const { rows } = await t().superuser.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit.audit_event WHERE action = 'auth.sign_in' AND org_id = $1`,
        [ORG_A],
      );
      expect(Number(rows[0]?.n)).toBe(3);
      const seals = await t().superuser.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit.audit_seal`,
      );
      expect(Number(seals.rows[0]?.n)).toBe(3);
    });
  });

  describe('org isolation (TC-F-002-27)', () => {
    it('a query outside withOrg() errors (fail closed)', async () => {
      const app = await t().pool('cp_app', 1);
      expect(await sqlState(app.query(`SELECT * FROM cp.organization`))).toBeDefined();
      const reader = await t().pool('audit_reader', 1);
      expect(await sqlState(reader.query(`SELECT * FROM audit.audit_event`))).toBeDefined();
    });

    it("another org's rows are invisible to the app and reader roles", async () => {
      const writer = await t().pool('audit_writer', 1);
      await insertAs(writer, ORG_B, 'audit.audit_event', [
        auditRow(ORG_B, { action: 'auth.sign_out' }),
      ]);
      const kApp = createDb<Database>(await t().pool('cp_app', 1));
      const orgs = await withOrg(kApp, ORG_A, (trx) =>
        trx.selectFrom('cp.organization').select('id').execute(),
      );
      expect(orgs).toEqual([{ id: ORG_A }]);
      const kReader = createDb<Database>(await t().pool('audit_reader', 1));
      const seen = await withOrg(kReader, ORG_A, (trx) =>
        trx.selectFrom('audit.audit_event').select('org_id').distinct().execute(),
      );
      expect(seen).toEqual([{ org_id: ORG_A }]);
    });

    it('the pooled connection has no org after withOrg', async () => {
      const pool = await t().pool('cp_app', 1);
      const kdb = createDb<Database>(pool);
      await withOrg(kdb, ORG_A, async (trx) => {
        const { rows } = await sql<{
          org: string;
        }>`select current_setting('app.org_id') as org`.execute(trx);
        expect(rows[0]?.org).toBe(ORG_A);
      });
      const after = await pool.query<{ org: string | null }>(
        `select current_setting('app.org_id', true) as org`,
      );
      expect(after.rows[0]?.org ?? '').toBe('');
      expect(await sqlState(pool.query(`SELECT * FROM cp.organization`))).toBeDefined();
    });

    it('withOrg refuses a non-UUID org id', async () => {
      const kdb = createDb<Database>(await t().pool('cp_app', 1));
      await expect(
        withOrg(kdb, "x'; drop table cp.organization; --", () => Promise.resolve(1)),
      ).rejects.toThrow(/UUID/);
    });

    it('organization.region is immutable', async () => {
      const pool = await t().pool('cp_app', 1);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`select set_config('app.org_id', $1, true)`, [ORG_A]);
        await client.query(`UPDATE cp.organization SET name = 'Renamed' WHERE id = $1`, [ORG_A]);
        expect(
          await sqlState(
            client.query(`UPDATE cp.organization SET region = 'us-east' WHERE id = $1`, [ORG_A]),
          ),
        ).toBe('23514');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });
});

describe.skipIf(stack === undefined)('UTF-8 refusals (AC-15)', () => {
  let ascii: TestDatabase | undefined;
  beforeAll(async () => {
    ascii = await createTestDatabase(stack!, { encoding: 'SQL_ASCII', bootstrap: false });
  });
  afterAll(async () => {
    await ascii?.drop();
  });

  it('bootstrap-roles.sql refuses a non-UTF-8 database', async () => {
    const { readFileSync } = await import('node:fs');
    const { BOOTSTRAP_ROLES_SQL } = await import('@ralysa/dev-stack/harness');
    await expect(ascii!.superuser.query(readFileSync(BOOTSTRAP_ROLES_SQL, 'utf8'))).rejects.toThrow(
      /UTF8/,
    );
  });

  it('migrate refuses a non-UTF-8 database before running anything', async () => {
    const { dbPassword } = await import('@ralysa/dev-stack/harness');
    await expect(
      runMigrations({
        set: 'cp',
        endpoint: ascii!.endpoint,
        orgId: ORG_A,
        credential: { user: 'ralysa_migrator', password: await dbPassword(stack!, 'migrator') },
      }),
    ).rejects.toThrow(/UTF8/);
  });

  it('migrate refuses the wrong login role for a set', async () => {
    await expect(
      runMigrations({
        set: 'audit',
        endpoint: ascii!.endpoint,
        orgId: ORG_A,
        credential: { user: 'ralysa_migrator', password: 'unused' },
      }),
    ).rejects.toThrow(/runs as ralysa_audit_migrator/);
  });
});
