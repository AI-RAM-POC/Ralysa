#!/usr/bin/env node
// control-plane entry points (F-002 design §2.1, §3.8). Each entry point loads only its own
// config schema and authenticates to OpenBao as its own role [SEC-F002-02].
//
//   control-plane migrate --config <file>           cp set, as ralysa_migrator
//   control-plane migrate --audit --config <file>   audit set, as ralysa_audit_migrator (break-glass)
//
// `serve`, `sealer`, `audit-verify` and `bootstrap-org` arrive with F-002-T06/T07/T16.
// The config path may also come from RALYSA_CONFIG.
import { parseArgs } from 'node:util';
import { commonProductionRefusals } from './config/guards.js';
import { ConfigError, loadConfigFile } from './config/load.js';
import { type CommonConfig, MigrateAuditConfig, MigrateConfig } from './config/schema.js';
import { type MigrationSet, runMigrations } from './db/migrate.js';
import { openVault } from './secrets/vault.js';

const USAGE = 'usage: control-plane migrate [--audit] --config <file>';

function log(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
}

async function migrateCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { audit: { type: 'boolean', default: false }, config: { type: 'string' } },
    strict: true,
  });
  const path = values.config ?? process.env.RALYSA_CONFIG;
  if (path === undefined) throw new ConfigError(USAGE);
  const set: MigrationSet = values.audit ? 'audit' : 'cp';
  const config: CommonConfig =
    set === 'audit'
      ? loadConfigFile(MigrateAuditConfig, path)
      : loadConfigFile(MigrateConfig, path);
  const refusals = commonProductionRefusals(config);
  if (refusals.length > 0) throw new ConfigError('refusing to start', refusals);

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
  log({ level: 'info', msg: 'migrate', set, applied: result.applied });
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'migrate') return await migrateCommand(rest);
    process.stderr.write(`${USAGE}\n`);
    return 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log({ level: 'error', msg: `${String(command)} failed`, error: message });
    return error instanceof ConfigError ? 2 : 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
