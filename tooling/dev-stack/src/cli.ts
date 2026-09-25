#!/usr/bin/env node
// dev-stack CLI (F-002 design §8.2). Runs on Node 24 type stripping, with no installed packages:
//   node tooling/dev-stack/src/cli.ts env [--out <file>] [--force] [--github-mask]
//   node tooling/dev-stack/src/cli.ts bootstrap [--env-file <file>]
// `env` writes deploy/docker/dev/.env; `bootstrap` sets up OpenBao, then the Postgres roles.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { rolesScript, runPsql, verifiersFor } from './bootstrap-db.ts';
import { bootstrapVault, markBootstrapped, readDbPassword } from './bootstrap-vault.ts';
import { EnvFileError, readEnvFile, writeEnvFile } from './env.ts';
import { baoClient } from './openbao.ts';
import {
  BOOTSTRAP_ROLES_SQL,
  COMPOSE_FILE,
  DB_ROLES,
  DEFAULT_ENV_FILE,
  OPENBAO_ADDR,
} from './stack.ts';

const USAGE = `usage:
  node tooling/dev-stack/src/cli.ts env [--out <file>] [--force] [--github-mask]
  node tooling/dev-stack/src/cli.ts bootstrap [--env-file <file>]`;

function envCommand(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: 'string', default: DEFAULT_ENV_FILE },
      force: { type: 'boolean', default: false },
      'github-mask': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const result = writeEnvFile({
    out: values.out,
    force: values.force,
    mask: values['github-mask'] ? (line) => process.stdout.write(`${line}\n`) : undefined,
  });
  console.log(`wrote ${result.path} (mode 0600): ${result.keys.join(', ')}`);
}

async function bootstrapCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { 'env-file': { type: 'string', default: DEFAULT_ENV_FILE } },
    strict: true,
  });
  const envFile = values['env-file'];
  const env = readEnvFile(envFile);
  if (env.BAO_DEV_ROOT_TOKEN_ID === undefined) {
    throw new Error(`${envFile} has no BAO_DEV_ROOT_TOKEN_ID; run the env command first`);
  }
  const root = baoClient(OPENBAO_ADDR, env.BAO_DEV_ROOT_TOKEN_ID);

  const vault = await bootstrapVault(root);
  console.log(`openbao: transit keys ${vault.keys.join(', ')}`);
  console.log(`openbao: kv entries created ${String(vault.kvCreated.length)} (existing kept)`);
  console.log(`openbao: policies ${vault.policies.join(', ')}`);
  console.log(`openbao: approle roles ${vault.appRoles.join(', ')}`);

  const passwords: Record<string, string> = {};
  for (const { key } of DB_ROLES) passwords[key] = await readDbPassword(root, key);
  await runPsql({
    composeFile: COMPOSE_FILE,
    envFile,
    script: `${rolesScript(verifiersFor(passwords))}${readFileSync(BOOTSTRAP_ROLES_SQL, 'utf8')}`,
  });
  console.log(`postgres: UTF8 checked; login roles ${DB_ROLES.map((r) => r.role).join(', ')}`);
  console.log('postgres: bootstrap-roles.sql applied (audit owner, grants, DDL event trigger)');
  console.log(
    'postgres: migrate with `pnpm --filter @ralysa/control-plane migrate:audit:dev` then `migrate:dev` (after build)',
  );
  // Last step: the harness treats the stack as ready only once this marker exists.
  await markBootstrapped(
    root,
    DB_ROLES.map((r) => r.role),
  );
  console.log('dev-stack: bootstrap complete');
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'env') envCommand(rest);
    else if (command === 'bootstrap') await bootstrapCommand(rest);
    else {
      console.error(USAGE);
      return 2;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`dev-stack ${String(command)}: ${message}`);
    return error instanceof EnvFileError ? 2 : 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
