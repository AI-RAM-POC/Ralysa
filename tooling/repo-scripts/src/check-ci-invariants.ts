// check-ci-invariants (F-001 design §6.2, §6.4, §8.2; TC-F-001-44; SEC-F001-06, -20, -21): the
// CI settings the security review depends on can't silently regress.
// - package.json#packageManager pins pnpm to an exact version with a +sha512 hash.
// - `concurrency.cancel-in-progress` is never an unconditional `true` (a second merge must not
//   cancel the first main run and its full-history scan).
// - A job that scans a commit range or history checks out with `fetch-depth: 0`.
// - Every direct gitleaks call passes --config (workflows, .githooks and tooling/repo-scripts/bin).
// - The `secret-scan` job runs no install and no build.
// - Every Playwright image reference is pinned by digest, and all use the same digest (CI and
//   apps/ui-lab/scripts/e2e-update.sh), once T13/T14 add them.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Finding, isRecord, readJson, readYaml } from './lib/repo.ts';

const WORKFLOWS_DIR = '.github/workflows';
const PLAYWRIGHT_IMAGE = /mcr\.microsoft\.com\/playwright:[^\s'"`]+/g;
const E2E_UPDATE = 'apps/ui-lab/scripts/e2e-update.sh';
/** A gitleaks subcommand invocation: `gitleaks dir|git|detect|protect|directory|file|stdin`. */
const GITLEAKS_CALL = /\bgitleaks(?:["']|\s)+(?:dir|git|detect|protect|directory|file|stdin)\b/;
const RANGE_SCAN = /secret-scan(?:-cli\.ts)?["']?\s+(?:pr|history)\b/;

export interface CiFiles {
  packageJson: unknown;
  /** Workflow path → parsed YAML. */
  workflows: Map<string, unknown>;
  /** Other files to scan for gitleaks calls and image references: path → text. */
  scripts: Map<string, string>;
}

function stepsOf(job: Record<string, unknown>): Record<string, unknown>[] {
  return (Array.isArray(job.steps) ? job.steps : []).filter(isRecord);
}

function runText(step: Record<string, unknown>): string {
  return typeof step.run === 'string' ? step.run : '';
}

/** Joins shell line continuations, so a call split over lines is checked as one command. */
function commands(text: string): string[] {
  return text.replace(/\\\n/g, ' ').split('\n');
}

function checkGitleaksCalls(path: string, text: string, findings: Finding[]): void {
  for (const line of commands(text)) {
    if (line.trim().startsWith('#')) continue;
    if (GITLEAKS_CALL.test(line) && !/(?:^|\s)(?:--config(?:=|\s)|-c\s)/.test(line)) {
      findings.push({
        rule: 'ci/gitleaks-config',
        path,
        message: `a gitleaks call without --config: "${line.trim()}" (SEC-F001-06)`,
      });
    }
  }
}

function checkCancelInProgress(
  path: string,
  where: string,
  owner: Record<string, unknown>,
  findings: Finding[],
): void {
  const concurrency = owner.concurrency;
  if (!isRecord(concurrency)) return;
  const value = concurrency['cancel-in-progress'];
  if (value === true || value === 'true') {
    findings.push({
      rule: 'ci/cancel-in-progress',
      path,
      message: `${where}concurrency.cancel-in-progress is unconditionally true; use \${{ github.event_name == 'pull_request' }} so main runs are never cancelled (SEC-F001-21)`,
    });
  }
}

export function checkCiInvariants(files: CiFiles): Finding[] {
  const findings: Finding[] = [];

  const pkg = files.packageJson;
  const pm = isRecord(pkg) ? pkg.packageManager : undefined;
  if (typeof pm !== 'string' || !/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/.test(pm)) {
    findings.push({
      rule: 'ci/package-manager',
      path: 'package.json',
      message: `packageManager must be "pnpm@<x.y.z>+sha512.<hash>" so Corepack verifies it (SEC-F001-20); got ${JSON.stringify(pm)}`,
    });
  }

  const images = new Map<string, string[]>();
  const noteImages = (path: string, text: string): void => {
    for (const match of text.matchAll(PLAYWRIGHT_IMAGE)) {
      images.set(match[0], [...(images.get(match[0]) ?? []), path]);
    }
  };

  for (const [path, workflow] of files.workflows) {
    if (!isRecord(workflow)) {
      findings.push({ rule: 'ci/workflow', path, message: 'not a YAML mapping' });
      continue;
    }
    checkCancelInProgress(path, '', workflow, findings);
    const jobs = isRecord(workflow.jobs) ? workflow.jobs : {};
    for (const [name, rawJob] of Object.entries(jobs)) {
      if (!isRecord(rawJob)) continue;
      checkCancelInProgress(path, `jobs.${name}.`, rawJob, findings);
      const steps = stepsOf(rawJob);
      const text = steps.map(runText).join('\n');
      checkGitleaksCalls(`${path} (jobs.${name})`, text, findings);
      noteImages(path, JSON.stringify(rawJob));

      if (RANGE_SCAN.test(text)) {
        const deep = steps.some((step) => {
          const uses = typeof step.uses === 'string' ? step.uses : '';
          const withs = isRecord(step.with) ? step.with : {};
          return uses.startsWith('actions/checkout@') && String(withs['fetch-depth']) === '0';
        });
        if (!deep) {
          findings.push({
            rule: 'ci/fetch-depth',
            path,
            message: `jobs.${name} scans a commit range or history but its checkout has no fetch-depth: 0; the base commit wouldn't be there (SEC-F001-06)`,
          });
        }
      }

      if (name === 'secret-scan' && /\b(?:pnpm|npm|npx|corepack|turbo)\b/.test(text)) {
        findings.push({
          rule: 'ci/secret-scan-no-install',
          path,
          message:
            'jobs.secret-scan must run no install and no build (design §8.2): no pnpm, npm, npx, corepack or turbo',
        });
      }
    }
  }

  for (const [path, text] of files.scripts) {
    checkGitleaksCalls(path, text, findings);
    noteImages(path, text);
  }

  for (const [image, paths] of images) {
    if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
      findings.push({
        rule: 'ci/playwright-digest',
        path: paths.join(', '),
        message: `${image} is not pinned by digest (@sha256:…)`,
      });
    }
  }
  const digests = new Set([...images.keys()].map((image) => image.split('@')[1] ?? image));
  if (digests.size > 1) {
    findings.push({
      rule: 'ci/playwright-digest',
      path: [...new Set([...images.values()].flat())].join(', '),
      message: `CI and e2e-update.sh must use one Playwright image digest; found ${String(digests.size)}`,
    });
  }
  return findings;
}

function readScripts(root: string): Map<string, string> {
  const scripts = new Map<string, string>();
  const add = (path: string): void => {
    if (existsSync(join(root, path))) scripts.set(path, readFileSync(join(root, path), 'utf8'));
  };
  for (const dir of ['.githooks', 'tooling/repo-scripts/bin']) {
    if (!existsSync(join(root, dir))) continue;
    for (const entry of readdirSync(join(root, dir))) {
      if (entry.endsWith('.txt')) continue;
      add(`${dir}/${entry}`);
    }
  }
  add(E2E_UPDATE);
  return scripts;
}

export function checkCiInvariantsFiles(root: string): Finding[] {
  const workflows = new Map<string, unknown>();
  const dir = join(root, WORKFLOWS_DIR);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir).sort()) {
      if (/\.ya?ml$/.test(entry))
        workflows.set(`${WORKFLOWS_DIR}/${entry}`, readYaml(join(dir, entry)));
    }
  }
  return checkCiInvariants({
    packageJson: readJson(join(root, 'package.json')),
    workflows,
    scripts: readScripts(root),
  });
}
