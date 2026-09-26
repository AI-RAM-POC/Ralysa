// control-plane entry points (F-002 design §2.1, §3.8). Each entry point loads only its own
// config schema and authenticates to OpenBao as its own role [SEC-F002-02]. `main.ts` is the
// executable; this module has no side effects on import, so tests can drive `main()` (#41).
//
//   control-plane migrate --config <file>           cp set, as ralysa_migrator
//   control-plane migrate --audit --config <file>   audit set, as ralysa_audit_migrator (break-glass)
//   control-plane sealer --config <file>            the sealer process, as ralysa_audit_sealer
//   control-plane audit-verify --config <file> [--org <uuid>] [--shard <s>] [--log-checkpoints <jsonl>]
//
//   control-plane serve --config <file>             the API (RTS, discovery, audit, directory), as ralysa_cp_app
//   control-plane bootstrap-org --config <file>     create or check the one Organization (serve config)
// The config path may also come from RALYSA_CONFIG.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Source } from '@ralysa/protocol/audit';
import { CustodyViolationError } from '@ralysa/secrets';
import { migrationAppliedEvents } from './audit/events.js';
import { createCheckpointSigner, dbCustodyRecorder } from './audit/sealer/checkpoint.js';
import { runSealerLoop } from './audit/sealer/sealer.js';
import { auditVerify, parseCheckpointLog } from './audit/verify/audit-verify.js';
import { createAuditWriter } from './audit/writer.js';
import { commonProductionRefusals, openBaoStorageRefusals } from './config/guards.js';
import { ConfigError, loadConfigFile } from './config/load.js';
import {
  AuditVerifyConfig,
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
import { bootstrapOrgCommand, serveCommand } from './serve.js';

const USAGE =
  'usage: control-plane <serve | bootstrap-org | migrate [--audit] | sealer | audit-verify [--org <uuid>] [--shard <s>] [--log-checkpoints <jsonl>]> --config <file>';
const logger = createJsonLogger();

function configPath(value: string | undefined): string {
  const path = value ?? process.env.RALYSA_CONFIG;
  if (path === undefined) throw new ConfigError(USAGE);
  return path;
}

/**
 * The production guards every one-shot entry point applies before it touches OpenBao or the
 * database (§3.8, SEC-F002-12): the config guards, then OpenBao `sys/seal-status` (in-memory,
 * sealed or unreachable is refused), exactly as `serve` does. Both are no-ops outside production.
 */
async function refuseUnsafe(config: CommonConfig): Promise<void> {
  const refusals = [...commonProductionRefusals(config), ...(await openBaoStorageRefusals(config))];
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
  await refuseUnsafe(config);

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
  await refuseUnsafe(config);
  const { secrets, keys } = openVault(config);
  const pool = createPool(
    config.db,
    {
      user: 'ralysa_audit_sealer',
      password: async () => (await secrets.get(config.db_credentials.audit_sealer)).value,
    },
    { applicationName: 'ralysa-control-plane:sealer', max: 2 },
  );
  const sealerDb = createDb<Database>(pool);
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      controller.abort();
    });
  }
  // Custody violations are recorded through audit.record_custody_violation() on the sealer's
  // own pool: the sealer holds no writer credential (SEC-F002-34).
  const signer = createCheckpointSigner({
    custody: keys,
    key: config.checkpoint_key,
    recordViolation: dbCustodyRecorder(sealerDb, config.org.id),
    logger,
  });
  logger.info('sealer_started', {
    org_id: config.org.id,
    interval_ms: config.interval_ms,
    checkpoint_interval_s: config.checkpoint_interval_s,
  });
  try {
    await runSealerLoop({
      db: sealerDb,
      orgId: config.org.id,
      intervalMs: config.interval_ms,
      sweepEveryMs: config.sweep_interval_s * 1000,
      logger,
      signal: controller.signal,
      checkpoints: {
        signer,
        intervalMs: config.checkpoint_interval_s * 1000,
        custodyPollMs: config.custody_poll_s * 1000,
      },
    });
  } finally {
    await pool.end();
  }
  logger.info('sealer_stopped');
  return 0;
}

async function auditVerifyCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      org: { type: 'string' },
      shard: { type: 'string' },
      'log-checkpoints': { type: 'string' },
    },
    strict: true,
  });
  const config = loadConfigFile(AuditVerifyConfig, configPath(values.config));
  await refuseUnsafe(config);
  const { secrets, keys } = openVault(config);
  let publicKeys: Map<number, (typeof described.versions)[number]['jwk']>;
  let described: Awaited<ReturnType<typeof keys.describe>>;
  try {
    described = await keys.describe(config.checkpoint_key);
    publicKeys = new Map(described.versions.map((v) => [v.version, v.jwk]));
  } catch (error) {
    if (error instanceof CustodyViolationError) {
      logger.error('audit_verify_failed', {
        reason: 'checkpoint key custody violation',
        key: error.key,
      });
      return 1;
    }
    throw error;
  }
  const shard = values.shard;
  if (shard !== undefined && !(Source.options as readonly string[]).includes(shard)) {
    throw new ConfigError(`unknown shard ${shard}`);
  }
  const pool = createPool(
    config.db,
    {
      user: 'ralysa_audit_reader',
      password: async () => (await secrets.get(config.db_credentials.audit_reader)).value,
    },
    { applicationName: 'ralysa-control-plane:audit-verify', max: 2 },
  );
  try {
    const logPath = values['log-checkpoints'];
    const result = await auditVerify({
      db: createDb<Database>(pool),
      orgId: values.org ?? config.org.id,
      shards: shard === undefined ? Source.options : [shard],
      publicKeys,
      ...(logPath === undefined
        ? {}
        : { logCheckpoints: parseCheckpointLog(readFileSync(logPath, 'utf8')) }),
    });
    for (const finding of result.findings) logger.error('audit_verify_finding', { ...finding });
    for (const report of result.shards) logger.info('audit_verify_shard', { ...report });
    logger.info('audit_verify', {
      ok: result.findings.length === 0,
      findings: result.findings.length,
    });
    return result.findings.length === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'serve') return await serveCommand(rest);
    if (command === 'bootstrap-org') return await bootstrapOrgCommand(rest, logger);
    if (command === 'migrate') return await migrateCommand(rest);
    if (command === 'sealer') return await sealerCommand(rest);
    if (command === 'audit-verify') return await auditVerifyCommand(rest);
    process.stderr.write(`${USAGE}\n`);
    return 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`${String(command)} failed`, { error: message });
    return error instanceof ConfigError ? 2 : 1;
  }
}
