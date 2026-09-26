#!/usr/bin/env node
// ralysa-repo: entry point for the repository checks. It runs directly on Node 24's type
// stripping, so there is no build step and no TS runner dependency.
//   ralysa-repo repo-check               every repo-level check (the CI repo-checks job); stops
//                                        after config-gate if that has findings
//   ralysa-repo config-gate              static install-time config gate (also pre-install-gate.ts)
//   ralysa-repo check-workspaces         workspace contract, scripts, lifecycle/specifier/Python rules
//   ralysa-repo check-tsrefs             tsconfig project references
//   ralysa-repo check-turbo-config       remote cache off, globalDependencies, uncached checks
//   ralysa-repo check-i18n               i18n catalogs: parity, plurals, grammar, native review
//   ralysa-repo check-ui-lint            UI workspaces run eslint (react-ui) and stylelint
//   ralysa-repo check-banned-deps       banned packages in the lockfile graph (SR-03, ADR-0012)
//   ralysa-repo check-imports            dependency-cruiser import boundaries (.dependency-cruiser.cjs)
//   ralysa-repo check-gitleaks-config    the two gitleaks configs (no artefact allow-list, same rules)
//   ralysa-repo check-ci-invariants      packageManager hash, fetch-depth, gitleaks --config, cancel-in-progress
//   ralysa-repo check-no-password        no password, PIN, OTP or client secret in the OpenAPI docs or client code (AC-3)
//   ralysa-repo check-provider-hosts [--artefacts]   provider API hostnames in source (or shipped artefacts)
//   ralysa-repo check-no-demo            demo sentinel and sample text in shipped builds (after a build)
//   ralysa-repo check-integration-scope  *.int.ts read the dev stack only inside hooks and tests
//   ralysa-repo check-migrations-immutable  released control-plane migrations never change
//   ralysa-repo migrations-lock          record new migration hashes in migrations.lock.json
// The secret scans themselves run through secret-scan-cli.ts (dependency-free).
//   ralysa-repo placeholder-guard        run inside a placeholder package (its four scripts)
//   ralysa-repo scaffold <path> --kind <kind>
//   ralysa-repo summary [--file <run.json>] [--out <file>]
//   ralysa-repo ci-duration [--limit <n>] [--workflow <file.yml>] [--repo <owner/name>]
//                                        p50/p95 of the last 30 PR CI runs, through gh (T18)
import { appendFileSync } from 'node:fs';
import { checkBannedDeps } from './check-banned-deps.ts';
import { ciDuration } from './ci-duration.ts';
import { checkCiInvariantsFiles } from './check-ci-invariants.ts';
import { checkGitleaksConfigFiles } from './check-gitleaks-config.ts';
import { checkI18n } from './check-i18n.ts';
import { checkNoDemo } from './check-no-demo.ts';
import { checkNoPassword } from './check-no-password.ts';
import { checkImports } from './check-imports.ts';
import { checkIntegrationScope } from './check-integration-scope.ts';
import { checkMigrationsImmutable, writeMigrationsLock } from './check-migrations-immutable.ts';
import { checkProviderHosts, checkProviderHostsInArtefacts } from './check-provider-hosts.ts';
import { checkUiLint } from './check-ui-lint.ts';
import { checkTsrefs } from './check-tsrefs.ts';
import { checkConfigGate } from './config-gate.ts';
import { checkTurboConfigFile } from './check-turbo-config.ts';
import { checkWorkspaces } from './check-workspaces.ts';
import { REQUIRED_SCRIPTS } from './contracts/workspace.ts';
import { type Finding, findRepoRoot, formatFindings } from './lib/repo.ts';
import { placeholderGuard } from './placeholder-guard.ts';
import { SCAFFOLD_KINDS, type ScaffoldKind, ScaffoldError, scaffold } from './scaffold.ts';
import { latestSummaryFile, summaryFromFile } from './summary.ts';

type Check = (root: string) => Finding[] | Promise<Finding[]>;

// None of these start pnpm. config-gate runs first; check-workspaces also runs it itself.
const REPO_CHECKS: Record<string, Check> = {
  'config-gate': (root) => checkConfigGate({ root }).findings,
  'check-workspaces': (root) => checkWorkspaces({ root }),
  'check-tsrefs': (root) => checkTsrefs({ root }),
  'check-turbo-config': (root) => checkTurboConfigFile(root),
  'check-banned-deps': (root) => checkBannedDeps({ root }),
  'check-imports': (root) => checkImports({ root }),
  'check-gitleaks-config': (root) => checkGitleaksConfigFiles(root),
  'check-ci-invariants': (root) => checkCiInvariantsFiles(root),
  'check-provider-hosts': (root) => checkProviderHosts(root),
  'check-no-password': (root) => checkNoPassword(root),
  'check-ui-lint': (root) => checkUiLint({ root }),
  'check-integration-scope': (root) => checkIntegrationScope({ root }),
  'check-migrations-immutable': (root) =>
    checkMigrationsImmutable({ root, ci: process.env.CI === '1' || process.env.CI === 'true' }),
  'check-i18n': (root) => {
    const { findings, warnings, needsReview } = checkI18n({ root });
    for (const warning of warnings)
      console.warn(`  ! [${warning.rule}] ${warning.path}: ${warning.message}`);
    for (const [dir, count] of Object.entries(needsReview)) {
      console.log(`  i ${dir}: ${String(count)} string(s) marked needs-native-review (OQ-D8)`);
    }
    return findings;
  },
};

function report(name: string, findings: Finding[]): boolean {
  if (findings.length === 0) {
    console.log(`✓ ${name}`);
    return true;
  }
  console.error(
    `✗ ${name} (${String(findings.length)} finding${findings.length === 1 ? '' : 's'})`,
  );
  console.error(formatFindings(findings));
  return false;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(argv: string[]): Promise<number> {
  const [command = 'help', ...args] = argv;
  const cwd = process.cwd();

  if (command === 'placeholder-guard') {
    const ok = report(`placeholder-guard ${cwd}`, placeholderGuard({ dir: cwd }));
    return ok ? 0 : 1;
  }

  const root = findRepoRoot(cwd);

  if (command === 'repo-check') {
    let ok = true;
    for (const [name, check] of Object.entries(REPO_CHECKS)) {
      const passed = report(name, await check(root));
      ok &&= passed;
      if (name === 'config-gate' && !passed) {
        console.error('Stopping: fix the config gate findings before running anything else.');
        return 1;
      }
    }
    return ok ? 0 : 1;
  }
  // Build-output check (the `quality` job, after the build): not part of repo-check.
  if (command === 'check-no-demo') {
    return report('check-no-demo', checkNoDemo(root)) ? 0 : 1;
  }
  if (command === 'check-provider-hosts' && args.includes('--artefacts')) {
    return report('check-provider-hosts --artefacts', checkProviderHostsInArtefacts(root)) ? 0 : 1;
  }
  const check = REPO_CHECKS[command];
  if (check !== undefined) return report(command, await check(root)) ? 0 : 1;

  if (command === 'migrations-lock') {
    const lock = writeMigrationsLock(root);
    console.log(
      `✓ migrations.lock.json: ${String(Object.keys(lock.migrations).length)} migrations`,
    );
    return report('check-migrations-immutable', checkMigrationsImmutable({ root })) ? 0 : 1;
  }
  if (command === 'scaffold') {
    const [target] = args;
    const kind = flag(args, '--kind');
    if (target === undefined || target.startsWith('--') || kind === undefined) {
      console.error(
        `usage: pnpm scaffold <apps|packages|services>/<name> --kind <${SCAFFOLD_KINDS.join('|')}>`,
      );
      return 2;
    }
    try {
      const result = scaffold({ root, target, kind: kind as ScaffoldKind });
      console.log(`Created ${result.packageName} in ${target}:`);
      for (const file of result.written) console.log(`  ${file}`);
      console.log('Added it to the root tsconfig.json references.');
      console.log('Next: pnpm install, then pnpm turbo run lint typecheck test build.');
      return 0;
    } catch (error) {
      if (error instanceof ScaffoldError) {
        console.error(`scaffold: ${error.message}`);
        return 1;
      }
      throw error;
    }
  }

  if (command === 'ci-duration') {
    try {
      return ciDuration(args);
    } catch (error) {
      console.error(`ci-duration: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  if (command === 'summary') {
    const file = flag(args, '--file') ?? latestSummaryFile(root);
    const { markdown, findings } = summaryFromFile(file, REQUIRED_SCRIPTS);
    const out = flag(args, '--out');
    if (out === undefined) console.log(markdown);
    else appendFileSync(out, `${markdown}\n`);
    return report('summary coverage', findings) ? 0 : 1;
  }

  console.error(
    `usage: ralysa-repo <${['repo-check', ...Object.keys(REPO_CHECKS), 'check-no-demo', 'placeholder-guard', 'scaffold', 'summary', 'ci-duration'].join('|')}>`,
  );
  return command === 'help' ? 0 : 2;
}

process.exitCode = await main(process.argv.slice(2));
