// The two migration sets and their runner (F-002 design §4.2, §4.3; [AR-10]; SEC-F002-01 a).
//
// - `cp`: run by `migrate` as ralysa_migrator; history in `ralysa_meta`.
// - `audit`: run by `migrate --audit` (break-glass) as ralysa_audit_migrator, which switches to
//   the NOLOGIN owner with SET ROLE on its one connection; history in `ralysa_meta_audit`.
//
// Kysely runs all pending migrations of a set in ONE transaction under its lock, so a failed
// batch rolls back whole (no CREATE INDEX CONCURRENTLY in migrations). Up only: `migrate` has no
// down path in any environment. Both refuse a non-UTF-8 server (AC-15).
//
// This file is the one place in application code that runs session-level settings (the
// SET ROLE above and app.org_id for the DDL event trigger's attribution). It uses a dedicated
// single-connection pool that is destroyed when the job ends, so nothing leaks to other users.
// The control-plane lint rule allows it here only (SEC-F002-31).
import { CompiledQuery, Kysely, PostgresDialect, sql } from 'kysely';
import { type Migration, Migrator } from 'kysely/migration';
import { AUDIT_MIGRATIONS } from './migrations/audit/index.js';
import { CP_MIGRATIONS } from './migrations/cp/index.js';
import { assertOrgId } from './kysely.js';
import { type DbCredential, type DbEndpoint, createPool } from './pools.js';

export type MigrationSet = 'cp' | 'audit';

interface SetDefinition {
  schema: string;
  migrations: Readonly<Record<string, Migration>>;
  /** The owner role the job switches to (audit only). */
  setRole?: 'ralysa_audit_owner';
  role: string;
}

export const MIGRATION_SETS: Readonly<Record<MigrationSet, SetDefinition>> = {
  cp: { schema: 'ralysa_meta', migrations: CP_MIGRATIONS, role: 'ralysa_migrator' },
  audit: {
    schema: 'ralysa_meta_audit',
    migrations: AUDIT_MIGRATIONS,
    setRole: 'ralysa_audit_owner',
    role: 'ralysa_audit_migrator',
  },
};

export interface MigrateOptions {
  set: MigrationSet;
  endpoint: DbEndpoint;
  /** The set's login role (ralysa_migrator or ralysa_audit_migrator) and its password. */
  credential: DbCredential;
  /** config.org.id: attributes DDL events and (T06) db.migration.applied. */
  orgId: string;
}

export interface MigrateResult {
  set: MigrationSet;
  applied: string[];
}

export class MigrationError extends Error {
  readonly set: MigrationSet;
  readonly failed: string | undefined;
  constructor(set: MigrationSet, failed: string | undefined, cause: unknown) {
    super(
      `migrate ${set}: ${failed === undefined ? 'failed' : `${failed} failed`}; the batch was rolled back`,
      { cause },
    );
    this.set = set;
    this.failed = failed;
  }
}

async function assertUtf8(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{
    encoding: string;
  }>`select current_setting('server_encoding') as encoding`.execute(db);
  const encoding = rows[0]?.encoding;
  if (encoding !== 'UTF8') {
    throw new Error(`server_encoding is ${String(encoding)}, Ralysa needs UTF8 (AC-15)`);
  }
}

export async function runMigrations(options: MigrateOptions): Promise<MigrateResult> {
  const definition = MIGRATION_SETS[options.set];
  assertOrgId(options.orgId);
  if (options.credential.user !== definition.role) {
    throw new Error(
      `migrate ${options.set} runs as ${definition.role}, not ${options.credential.user}`,
    );
  }
  const pool = createPool(options.endpoint, options.credential, {
    applicationName: `ralysa-control-plane:migrate-${options.set}`,
    max: 1,
  });
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool,
      onCreateConnection: async (connection) => {
        if (definition.setRole !== undefined) {
          await connection.executeQuery(CompiledQuery.raw(`SET ROLE ${definition.setRole}`));
        }
        await connection.executeQuery(
          CompiledQuery.raw(`select set_config('app.org_id', $1, false)`, [options.orgId]),
        );
      },
    }),
  });
  try {
    await assertUtf8(db);
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve({ ...definition.migrations }) },
      migrationTableSchema: definition.schema,
      migrationTableName: 'migration',
      migrationLockTableName: 'migration_lock',
    });
    const { error, results } = await migrator.migrateToLatest();
    if (error !== undefined) {
      const failed = results?.find((r) => r.status === 'Error')?.migrationName;
      throw new MigrationError(options.set, failed, error);
    }
    return {
      set: options.set,
      applied: (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName),
    };
  } finally {
    await db.destroy();
  }
}
