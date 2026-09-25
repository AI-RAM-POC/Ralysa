#!/usr/bin/env node
// control-plane entry points (F-002 design §2.1, §3.8). Each entry point loads only its own
// config schema and authenticates to OpenBao as its own role [SEC-F002-02].
//
//   control-plane migrate --config <file>           cp set, as ralysa_migrator
//   control-plane migrate --audit --config <file>   audit set, as ralysa_audit_migrator (break-glass)
//   control-plane sealer --config <file>            the sealer process, as ralysa_audit_sealer
//
// `serve`, `audit-verify` and `bootstrap-org` arrive with F-002-T07 and T16.
// The config path may also come from RALYSA_CONFIG.
import { parseArgs } from 'node:util';
import { migrationAppliedEvents } from './audit/events.js';
import { runSealerLoop } from './audit/sealer/sealer.js';
import { createAuditWriter } from './audit/writer.js';
import { commonProductionRefusals } from './config/guards.js';
import { ConfigError, loadConfigFile } from './config/load.js';
import {
  type CommonConfig,
  MigrateAuditConfig,
  MigrateConfig,
  SealerConfig,
} from './config/schema.js';
import { createDb } from './db/kysely.js';
import { type MigrationSet, runMigrations } from './db/migrate.js';
import { migrationChecksums } from './db/migration-checksums.js';
import { createPool } from './db/pools.js';
import type { Database } from './db/types.js';
import { createJsonLogger } from './observability/logger.js';
import { openVault } from './secrets/vault.js';

const USAGE = 'usage: control-plane <migrate [--audit] | sealer> --config <file>';
const logger = createJsonLogger();

function configPath(value: string | undefined): string {
  const path = value ?? process.env.RALYSA_CONFIG;
  if (path === undefined) throw new ConfigError(USAGE);
  return path;
}

function refuseUnsafe(config: CommonConfig): void {
  const refusals = commonProductionRefusals(config);
  if (refusals.length > 0) throw new ConfigError('refusing to start', refusals);
}

async function migrateCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { audit: { type: 'boolean', default: false }, config: { type: 'string' } },
    strict: true,
  });
  const path = configPath(values.config);
  const set: MigrationSet = values.audit ? 'audit' : 'cp';
  const config =
    set === 'audit'
      ? loadConfigFile(MigrateAuditConfig, path)
      : loadConfigFile(MigrateConfig, path);
  refuseUnsafe(config);

  const { secrets } = openVault(config);
  const credentialPath =
    'audit_migrator' in config.db_credentials
      ? config.db_credentials.audit_migrator
      : config.db_credentials.migrator;
  const user = set === 'audit' ? 'ralysa_audit_migrator' : 'ralysa_migrator';
  const result = await runMigrations({
    set,
    endpoint: config.db,
    orgId: config.org.id,
    credential: { user, password: async () => (await secrets.get(credentialPath)).value },
  });
  logger.info('migrate', { set, applied: result.applied });

  // SR-29: every migration path is audited, through the writer role like any other event.
  if (result.applied.length > 0) {
    const pool = createPool(
      config.db,
      {
        user: 'ralysa_audit_writer',
        password: async () => (await secrets.get(config.db_credentials.audit_writer)).value,
      },
      { applicationName: `ralysa-control-plane:migrate-${set}`, max: 1 },
    );
    try {
      const writer = createAuditWriter({ db: createDb<Database>(pool), timeoutMs: 5_000 });
      await writer.write(
        config.org.id,
        migrationAppliedEvents(set, result.applied, migrationChecksums()),
      );
    } catch (error) {
      throw new Error(
        `migrations applied but db.migration.applied was not recorded: ${(error as Error).message}`,
        { cause: error },
      );
    } finally {
      await pool.end();
    }
  }
  return 0;
}

async function sealerCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { config: { type: 'string' } }, strict: true });
  const config = loadConfigFile(SealerConfig, configPath(values.config));
  refuseUnsafe(config);
  const { secrets } = openVault(config);
  const pool = createPool(
    config.db,
    {
      user: 'ralysa_audit_sealer',
      password: async () => (await secrets.get(config.db_credentials.audit_sealer)).value,
    },
    { applicationName: 'ralysa-control-plane:sealer', max: 2 },
  );
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      controller.abort();
    });
  }
  logger.info('sealer_started', { org_id: config.org.id, interval_ms: config.interval_ms });
  try {
    await runSealerLoop({
      db: createDb<Database>(pool),
      orgId: config.org.id,
      intervalMs: config.interval_ms,
      sweepEveryMs: config.sweep_interval_s * 1000,
      logger,
      signal: controller.signal,
    });
  } finally {
    await pool.end();
  }
  logger.info('sealer_stopped');
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'migrate') return await migrateCommand(rest);
    if (command === 'sealer') return await sealerCommand(rest);
    process.stderr.write(`${USAGE}\n`);
    return 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`${String(command)} failed`, { error: message });
    return error instanceof ConfigError ? 2 : 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
