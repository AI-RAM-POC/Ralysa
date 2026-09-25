// check-ci-invariants (F-001 design §6.2, §6.4, §8.2; TC-F-001-44; SEC-F001-06, -20, -21): the
// CI settings the security review depends on can't silently regress.
// - package.json#packageManager pins pnpm to an exact version with a +sha512 hash.
// - `concurrency.cancel-in-progress` is never an unconditional `true` (a second merge must not
//   cancel the first main run and its full-history scan).
// - A job that scans a commit range or history checks out with `fetch-depth: 0`.
// - Every direct gitleaks call passes --config (workflows, .githooks and tooling/repo-scripts/bin).
// - The `secret-scan` job runs no install and no build.
// - Every Playwright image reference is pinned by digest, and all use the same digest (the CI
//   ui-e2e job and every script in apps/ui-lab/scripts/: e2e-container.sh, which e2e-update.sh
//   runs).
// F-002-T02 (design §2, §8.5; SEC-F002-27, -28):
// - `ci/pre-install-gate-first`: in every job of every workflow, the pre-install gate runs before
//   anything that invokes a package manager: a `run` line calling pnpm, pnpx, npx, npm, yarn,
//   corepack or turbo, `actions/setup-node` with a `cache` (it runs `pnpm store path` or the
//   like), or `pnpm/action-setup`.
// - `ci/integration-no-secrets`: a job named `integration` references no `secrets.*`, has
//   `permissions: contents: read` and nothing else, and checks out with
//   `persist-credentials: false`.
// - `ci/integration-artefact`: that job's container logs name `postgres` only (the OpenBao dev
//   server prints its root token and unseal key), and its uploads expire within 3 days.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Finding, isRecord, readJson, readYaml } from './lib/repo.ts';

const WORKFLOWS_DIR = '.github/workflows';
const PLAYWRIGHT_IMAGE = /mcr\.microsoft\.com\/playwright:[^\s'"`]+/g;
const E2E_SCRIPTS_DIR = 'apps/ui-lab/scripts';
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

/** A shell command word that runs a package manager (pnpm installs configDependencies first). */
const PACKAGE_MANAGER = /(?:^|[\s;&|(`])(?:pnpm|pnpx|npx|npm|yarn|corepack|turbo)(?=$|[\s;&|)`])/;
const PRE_INSTALL_GATE = /(?:^|[\s;&|])node\s+tooling\/repo-scripts\/src\/pre-install-gate\.ts\b/;

/** What in a `uses:` step shells out to a package manager, if anything. */
function packageManagerAction(step: Record<string, unknown>): string | undefined {
  const uses = typeof step.uses === 'string' ? step.uses : '';
  const withs = isRecord(step.with) ? step.with : {};
  if (uses.startsWith('pnpm/action-setup@')) return uses;
  if (uses.startsWith('actions/setup-node@') && withs.cache !== undefined && withs.cache !== '') {
    return `${uses} with cache: ${JSON.stringify(withs.cache)}`;
  }
  return undefined;
}

function checkPreInstallGateFirst(
  path: string,
  name: string,
  steps: Record<string, unknown>[],
  findings: Finding[],
): void {
  let gateSeen = false;
  for (const step of steps) {
    const action = packageManagerAction(step);
    if (action !== undefined && !gateSeen) {
      findings.push({
        rule: 'ci/pre-install-gate-first',
        path,
        message: `jobs.${name}: "${action}" runs a package manager before the pre-install gate; add "node tooling/repo-scripts/src/pre-install-gate.ts" first (SEC-F002-28)`,
      });
      return;
    }
    for (const line of commands(runText(step))) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue;
      if (PRE_INSTALL_GATE.test(trimmed)) gateSeen = true;
      else if (PACKAGE_MANAGER.test(trimmed) && !gateSeen) {
        findings.push({
          rule: 'ci/pre-install-gate-first',
          path,
          message: `jobs.${name}: "${trimmed}" runs before the pre-install gate; every pnpm command installs configDependencies and loads pnpmfiles (SEC-F002-28)`,
        });
        return;
      }
    }
  }
}

function checkIntegrationJob(
  path: string,
  job: Record<string, unknown>,
  steps: Record<string, unknown>[],
  findings: Finding[],
): void {
  const where = `${path} (jobs.integration)`;
  if (/\bsecrets\s*\./.test(JSON.stringify(job))) {
    findings.push({
      rule: 'ci/integration-no-secrets',
      path: where,
      message:
        'the integration job runs PR code and must reference no secrets.*; it generates throwaway credentials per run (SEC-F002-27)',
    });
  }
  const permissions = job.permissions;
  const leastPrivilege =
    isRecord(permissions) &&
    Object.keys(permissions).length === 1 &&
    permissions.contents === 'read';
  if (!leastPrivilege) {
    findings.push({
      rule: 'ci/integration-no-secrets',
      path: where,
      message: `the integration job needs "permissions: contents: read" and nothing else; got ${JSON.stringify(permissions)} (SEC-F002-27)`,
    });
  }
  for (const step of steps) {
    const uses = typeof step.uses === 'string' ? step.uses : '';
    const withs = isRecord(step.with) ? step.with : {};
    if (uses.startsWith('actions/checkout@')) {
      const persist = withs['persist-credentials'];
      if (persist !== false && persist !== 'false') {
        findings.push({
          rule: 'ci/integration-no-secrets',
          path: where,
          message:
            'the integration job checks out with credentials persisted; set "persist-credentials: false" (SEC-F002-27)',
        });
      }
    }
    if (uses.startsWith('actions/upload-artifact@')) {
      const days = Number(withs['retention-days']);
      if (!Number.isInteger(days) || days < 1 || days > 3) {
        findings.push({
          rule: 'ci/integration-artefact',
          path: where,
          message: 'integration artefacts need "retention-days" of at most 3 (SEC-F002-27)',
        });
      }
    }
    for (const line of commands(runText(step))) {
      if (!/\bdocker\s+compose\b.*\blogs\b/.test(line)) continue;
      const services = line.slice(line.search(/\blogs\b/) + 'logs'.length);
      if (/openbao/i.test(line) || !/\bpostgres\b/.test(services)) {
        findings.push({
          rule: 'ci/integration-artefact',
          path: where,
          message: `"${line.trim()}" must name the postgres service only: the OpenBao dev server logs its root token and unseal key (SEC-F002-27)`,
        });
      }
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
      checkPreInstallGateFirst(path, name, steps, findings);
      if (name === 'integration') checkIntegrationJob(path, rawJob, steps, findings);
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
      message: `CI and apps/ui-lab/scripts must use one Playwright image digest; found ${String(digests.size)}`,
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
  if (existsSync(join(root, E2E_SCRIPTS_DIR))) {
    for (const entry of readdirSync(join(root, E2E_SCRIPTS_DIR)).sort()) {
      if (entry.endsWith('.sh')) add(`${E2E_SCRIPTS_DIR}/${entry}`);
    }
  }
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
