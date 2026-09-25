#!/usr/bin/env node
// ralysa-repo: entry point for the repository checks. It runs directly on Node 24's type
// stripping, so there is no build step and no TS runner dependency.
//   ralysa-repo repo-check               every repo-level check (the CI repo-checks job)
//   ralysa-repo check-workspaces         workspace contract, scripts, lifecycle/specifier/Python rules
//   ralysa-repo check-tsrefs             tsconfig project references
//   ralysa-repo check-turbo-config       remote cache off, globalDependencies, uncached checks
//   ralysa-repo placeholder-guard        run inside a placeholder package (its four scripts)
//   ralysa-repo scaffold <path> --kind <kind>
//   ralysa-repo summary [--file <run.json>] [--out <file>]
import { appendFileSync } from 'node:fs';
import { checkTsrefs } from './check-tsrefs.ts';
import { checkTurboConfigFile } from './check-turbo-config.ts';
import { checkWorkspaces } from './check-workspaces.ts';
import { REQUIRED_SCRIPTS } from './contracts/workspace.ts';
import { type Finding, findRepoRoot, formatFindings } from './lib/repo.ts';
import { placeholderGuard } from './placeholder-guard.ts';
import { SCAFFOLD_KINDS, type ScaffoldKind, ScaffoldError, scaffold } from './scaffold.ts';
import { latestSummaryFile, summaryFromFile } from './summary.ts';

type Check = (root: string) => Finding[];

const REPO_CHECKS: Record<string, Check> = {
  'check-workspaces': (root) => checkWorkspaces({ root }),
  'check-tsrefs': (root) => checkTsrefs({ root }),
  'check-turbo-config': (root) => checkTurboConfigFile(root),
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

function main(argv: string[]): number {
  const [command = 'help', ...args] = argv;
  const cwd = process.cwd();

  if (command === 'placeholder-guard') {
    const ok = report(`placeholder-guard ${cwd}`, placeholderGuard({ dir: cwd }));
    return ok ? 0 : 1;
  }

  const root = findRepoRoot(cwd);

  if (command === 'repo-check') {
    const results = Object.entries(REPO_CHECKS).map(([name, check]) => report(name, check(root)));
    return results.every(Boolean) ? 0 : 1;
  }
  const check = REPO_CHECKS[command];
  if (check !== undefined) return report(command, check(root)) ? 0 : 1;

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

  if (command === 'summary') {
    const file = flag(args, '--file') ?? latestSummaryFile(root);
    const { markdown, findings } = summaryFromFile(file, REQUIRED_SCRIPTS);
    const out = flag(args, '--out');
    if (out === undefined) console.log(markdown);
    else appendFileSync(out, `${markdown}\n`);
    return report('summary coverage', findings) ? 0 : 1;
  }

  console.error(
    `usage: ralysa-repo <${['repo-check', ...Object.keys(REPO_CHECKS), 'placeholder-guard', 'scaffold', 'summary'].join('|')}>`,
  );
  return command === 'help' ? 0 : 2;
}

process.exitCode = main(process.argv.slice(2));
