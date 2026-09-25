#!/usr/bin/env node
// ralysa-repo: entry point for the repository checks (runs directly on Node 24's type stripping,
// so there is no build step and no TS runner dependency).
//   ralysa-repo repo-check         every repo-level check used by the CI repo-checks job
//   ralysa-repo check-workspaces   workspace contract, scripts, lifecycle/specifier/Python rules
//   ralysa-repo check-tsrefs       tsconfig project references
import { checkTsrefs } from './check-tsrefs.ts';
import { checkWorkspaces } from './check-workspaces.ts';
import { type Finding, findRepoRoot, formatFindings } from './lib/repo.ts';

type Check = (root: string) => Finding[];

const CHECKS: Record<string, Check> = {
  'check-workspaces': (root) => checkWorkspaces({ root }),
  'check-tsrefs': (root) => checkTsrefs({ root }),
};

function run(names: string[], root: string): number {
  let failed = 0;
  for (const name of names) {
    const check = CHECKS[name];
    if (check === undefined) throw new Error(`unknown check ${name}`);
    const findings = check(root);
    if (findings.length === 0) {
      console.log(`✓ ${name}`);
    } else {
      failed += 1;
      console.error(
        `✗ ${name} (${String(findings.length)} finding${findings.length === 1 ? '' : 's'})`,
      );
      console.error(formatFindings(findings));
    }
  }
  return failed === 0 ? 0 : 1;
}

function main(argv: string[]): number {
  const [command = 'help', ...args] = argv;
  const root = findRepoRoot(process.cwd());
  if (command === 'repo-check') return run(Object.keys(CHECKS), root);
  if (command in CHECKS) return run([command], root);
  console.error(
    `usage: ralysa-repo <${['repo-check', ...Object.keys(CHECKS)].join('|')}> ${args.join(' ')}`,
  );
  return command === 'help' ? 0 : 2;
}

process.exitCode = main(process.argv.slice(2));
