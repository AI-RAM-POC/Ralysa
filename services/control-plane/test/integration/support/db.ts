// Per-test databases on the dev-stack Postgres (F-002 design §8.1): each test file gets a fresh
// database, bootstrapped with bootstrap-roles.sql as the superuser and migrated with the real
// migrate code as the real roles, so files run in parallel and every run starts clean.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  BOOTSTRAP_ROLES_SQL,
  type DbRoleKey,
  type DevStack,
  dbPassword,
  uniqueName,
} from '@ralysa/dev-stack/harness';
import type { Insertable } from 'kysely';
import pg from 'pg';
import { type MigrateResult, runMigrations } from '../../../src/db/migrate.js';
import type { DbEndpoint } from '../../../src/db/pools.js';
import type { AuditEventTable } from '../../../src/db/types.js';

/** Serialises bootstrap-roles.sql across parallel test files. */
const BOOTSTRAP_LOCK = 7_300_216;

export const ROLE_OF: Record<DbRoleKey, string> = {
  migrator: 'ralysa_migrator',
  audit_migrator: 'ralysa_audit_migrator',
  cp_app: 'ralysa_cp_app',
  audit_writer: 'ralysa_audit_writer',
  audit_reader: 'ralysa_audit_reader',
  audit_sealer: 'ralysa_audit_sealer',
};

export interface TestDatabase {
  name: string;
  endpoint: DbEndpoint;
  /** A superuser client connected to the test database. */
  superuser: pg.Client;
  /** A small pool logged in as the role (password from OpenBao KV). */
  pool(key: DbRoleKey, max?: number): Promise<pg.Pool>;
  migrate(orgId: string): Promise<{ audit: MigrateResult; cp: MigrateResult }>;
  drop(): Promise<void>;
}

export async function createTestDatabase(
  stack: DevStack,
  options: { encoding?: 'UTF8' | 'SQL_ASCII'; bootstrap?: boolean } = {},
): Promise<TestDatabase> {
  const name = uniqueName('ralysa_t').replace(/-/g, '_');
  const admin = new pg.Client({ ...stack.postgres });
  await admin.connect();
  try {
    await admin.query(
      options.encoding === 'SQL_ASCII'
        ? `CREATE DATABASE ${name} ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`
        : `CREATE DATABASE ${name}`,
    );
  } finally {
    await admin.end();
  }
  const superuser = new pg.Client({ ...stack.postgres, database: name });
  await superuser.connect();
  if (options.bootstrap !== false) {
    // bootstrap-roles.sql ALTERs cluster-wide roles; test files run in parallel, and concurrent
    // ALTER ROLE fails with "tuple concurrently updated" (XX000). Advisory locks are per
    // database, so serialise on one held in the shared admin database.
    const lock = new pg.Client({ ...stack.postgres });
    await lock.connect();
    try {
      await lock.query('select pg_advisory_lock($1)', [BOOTSTRAP_LOCK]);
      await superuser.query(readFileSync(BOOTSTRAP_ROLES_SQL, 'utf8'));
    } finally {
      await lock.query('select pg_advisory_unlock($1)', [BOOTSTRAP_LOCK]).catch(() => undefined);
      await lock.end();
    }
  }
  const endpoint: DbEndpoint = {
    host: stack.postgres.host,
    port: stack.postgres.port,
    database: name,
    ssl: false,
  };
  const pools: pg.Pool[] = [];
  return {
    name,
    endpoint,
    superuser,
    async pool(key, max = 2) {
      const pool = new pg.Pool({
        ...endpoint,
        ssl: false,
        user: ROLE_OF[key],
        password: await dbPassword(stack, key),
        max,
      });
      pools.push(pool);
      return pool;
    },
    async migrate(orgId) {
      const audit = await runMigrations({
        set: 'audit',
        endpoint,
        orgId,
        credential: {
          user: 'ralysa_audit_migrator',
          password: await dbPassword(stack, 'audit_migrator'),
        },
      });
      const cp = await runMigrations({
        set: 'cp',
        endpoint,
        orgId,
        credential: { user: 'ralysa_migrator', password: await dbPassword(stack, 'migrator') },
      });
      return { audit, cp };
    },
    async drop() {
      await Promise.all(pools.map((p) => p.end()));
      await superuser.end();
      const cleanup = new pg.Client({ ...stack.postgres });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/** A minimal valid audit row for the writer columns. */
export function auditRow(
  orgId: string,
  overrides: Partial<Insertable<AuditEventTable>> = {},
): Insertable<AuditEventTable> {
  return {
    event_id: randomUUID(),
    org_id: orgId,
    action: 'auth.sign_in',
    actor_type: 'user',
    outcome: 'success',
    trace_id: randomUUID().replace(/-/g, ''),
    source: 'control-plane',
    attestation: 'server',
    details: '{}',
    ...overrides,
  };
}

/** Inserts rows with the given pooled client inside a transaction scoped to orgId. */
export async function insertAs(
  pool: pg.Pool,
  orgId: string,
  table: string,
  rows: object[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`select set_config('app.org_id', $1, true)`, [orgId]);
    for (const row of rows) {
      const columns = Object.keys(row);
      await client.query(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${String(i + 1)}`).join(', ')})`,
        Object.values(row),
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
}
