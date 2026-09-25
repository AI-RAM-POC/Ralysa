// Scanner self-tests (F-001 design §6.2.5; TC-F-001-03, -37, -38; SEC-F001-05, -06).
// Each case plants a synthetic credential set in a temp folder and runs the SAME wrapper and
// flags as the real scans, with the config passed explicitly. Dependency-free, like
// secret-scan.ts, so it runs in the no-install `secret-scan` job.
//
// Every synthetic value is assembled from fragments and random characters at runtime, so no
// matching literal exists in the repository, and none was ever issued by any provider.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARTEFACT_CONFIG,
  REPO_CONFIG,
  type ScanResult,
  SecretScanError,
  assertRange,
  runGitleaks,
} from './secret-scan.ts';

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const ALNUM = UPPER + LOWER + DIGITS;

/**
 * Joins fragments at runtime. Token prefixes are kept apart in the source, so no scanner (ours
 * or a hosting provider's) sees even a prefix-shaped literal here.
 */
export function frag(...parts: string[]): string {
  return parts.join('');
}

/** `length` random characters from `alphabet`. */
export function randomFrom(alphabet: string, length: number): string {
  let out = '';
  for (const byte of randomBytes(length)) out += alphabet.charAt(byte % alphabet.length);
  return out;
}

export interface Plant {
  /** The rule gitleaks must report for this line. */
  rule: string;
  /** The line as it appears in the planted file. */
  line: string;
}

/**
 * The synthetic credential set: one line per expected rule. Prefixes are split so the source
 * never holds a detectable token.
 */
export function syntheticSet(): Plant[] {
  const pem = [
    frag('-----BEGIN ', 'PRIVATE', ' KEY-----'),
    ...Array.from({ length: 4 }, () => randomFrom(`${ALNUM}+/`, 64)),
    frag('-----END ', 'PRIVATE', ' KEY-----'),
  ].join('\\n');
  return [
    {
      rule: 'aws-access-token',
      line: `aws_id = "${frag('AK', 'IA')}${randomFrom(`${UPPER}234567`, 16)}"`,
    },
    { rule: 'github-pat', line: `token = "${frag('gh', 'p_')}${randomFrom(ALNUM, 36)}"` },
    {
      rule: 'anthropic-api-key',
      line: `key = "${frag('sk-', 'ant-', 'api03-')}${randomFrom(`${ALNUM}_-`, 93)}AA"`,
    },
    { rule: 'private-key', line: `pem = "${pem}"` },
    {
      rule: 'azure-openai-key',
      line: `AZURE_OPENAI_API_KEY = "${randomFrom('0123456789abcdef', 32)}"`,
    },
    {
      rule: 'litellm-key',
      line: `LITELLM_MASTER_KEY = "${frag('sk', '-')}${randomFrom(`${ALNUM}_-`, 24)}"`,
    },
    { rule: 'mistral-api-key', line: `MISTRAL_API_KEY = "${randomFrom(ALNUM, 32)}"` },
    { rule: 'groq-api-key', line: `groq = "${frag('gs', 'k_')}${randomFrom(ALNUM, 52)}"` },
    { rule: 'ralysa-selftest-canary', line: `canary = "${canary()}"` },
  ];
}

/**
 * Artefact paths that gitleaks 8.30.1's default global allow-list skips (an image extension, a
 * vendor-named bundle, node_modules, a font extension, a path containing "gitleaks.toml"). The
 * artefact config has no [extend], so none of them may be skipped (T05-1).
 */
export const ARTEFACT_SKIP_SHAPES = [
  'assets/logo-abc123.svg',
  'assets/swagger-ui-abc123.js',
  'node_modules/vendored-lib/index.js',
  'assets/inter-abc123.woff2',
  `assets/${frag('gitleaks', '.toml')}.js`,
] as const;

/** A copied default rule (GitHub PAT) and a custom one (canary), one per line. */
function shapePlants(): Plant[] {
  return [
    { rule: 'github-pat', line: `<!-- ${frag('gh', 'p_')}${randomFrom(ALNUM, 36)} -->` },
    { rule: 'ralysa-selftest-canary', line: `<text>${canary()}</text>` },
  ];
}

export function canary(): string {
  return `${frag('RALYSA_SELFTEST', '_CANARY_')}${randomFrom(UPPER + DIGITS, 24)}`;
}

function plantFile(dir: string, relativePath: string, plants: Plant[]): void {
  const full = join(dir, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, `${plants.map((p) => p.line).join('\n')}\n`);
}

export interface CaseResult {
  name: string;
  ok: boolean;
  problems: string[];
}

/** Every expected rule must be reported at its planted file and line. */
function expectPlants(
  name: string,
  result: ScanResult,
  file: string,
  plants: Plant[],
  extra: (result: ScanResult) => string[] = () => [],
): CaseResult {
  const problems: string[] = [];
  if (result.exitCode !== 1) problems.push(`expected exit 1, got ${String(result.exitCode)}`);
  for (const [index, plant] of plants.entries()) {
    const hit = result.findings.some(
      (f) => f.rule === plant.rule && f.file === file && f.line === index + 1,
    );
    if (!hit) problems.push(`${plant.rule} not reported at ${file}:${String(index + 1)}`);
  }
  problems.push(...extra(result));
  return { name, ok: problems.length === 0, problems };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'selftest',
      GIT_AUTHOR_EMAIL: 'selftest@example.invalid',
      GIT_COMMITTER_NAME: 'selftest',
      GIT_COMMITTER_EMAIL: 'selftest@example.invalid',
    },
  });
  if (result.status !== 0) throw new SecretScanError(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

export interface SelftestOptions {
  root: string;
  binary: string;
  /** Where the cases plant their files; defaults to $RUNNER_TEMP or the OS temp folder. */
  workDir?: string;
  reportDir: string;
}

export function runSelftests(options: SelftestOptions): CaseResult[] {
  const base = mkdtempSync(
    join(options.workDir ?? process.env.RUNNER_TEMP ?? tmpdir(), 'ralysa-selftest-'),
  );
  const repoConfig = join(options.root, REPO_CONFIG);
  const artefactConfig = join(options.root, ARTEFACT_CONFIG);
  const results: CaseResult[] = [];
  const run = (name: string, body: () => CaseResult): void => {
    try {
      results.push(body());
    } catch (error) {
      results.push({ name, ok: false, problems: [String(error)] });
    }
  };

  // dir: the tree-scan command over a planted folder.
  run('dir', () => {
    const dir = join(base, 'selftest-dir');
    const plants = syntheticSet();
    plantFile(dir, 'src/config.ts', plants);
    const result = runGitleaks({
      binary: options.binary,
      label: 'selftest-dir',
      mode: 'dir',
      target: dir,
      config: repoConfig,
      reportDir: options.reportDir,
    });
    return expectPlants('dir', result, 'src/config.ts', plants);
  });

  // git: a clean commit, then one with the synthetic set, scanned as a PR range.
  run('git', () => {
    const repo = join(base, 'selftest-git');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '--quiet', '--initial-branch=main']);
    writeFileSync(join(repo, 'README.md'), 'clean\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '--quiet', '--no-verify', '-m', 'clean']);
    const first = git(repo, ['rev-parse', 'HEAD']);
    const plants = syntheticSet();
    plantFile(repo, 'src/settings.ts', plants);
    git(repo, ['add', '.']);
    git(repo, ['commit', '--quiet', '--no-verify', '-m', 'synthetic']);
    const second = git(repo, ['rev-parse', 'HEAD']);
    const count = assertRange(repo, first, second);
    const result = runGitleaks({
      binary: options.binary,
      label: 'selftest-git',
      mode: 'git',
      target: repo,
      config: repoConfig,
      logOpts: `${first}..${second}`,
      reportDir: options.reportDir,
    });
    return expectPlants('git', result, 'src/settings.ts', plants, (r) => {
      const problems: string[] = [];
      if (count !== 1) problems.push(`expected a 1-commit range, got ${String(count)}`);
      if (!r.findings.every((f) => f.commit === second))
        problems.push(`findings not tied to commit ${second}`);
      return problems;
    });
  });

  // artefact: with the artefact config (SEC-F001-05, T05-1), the whole synthetic set under a
  // dist/ path (so the copied default rules fire, not only ours), plus one planted file for each
  // shape gitleaks' default global allow-list used to skip. Each must be found.
  run('artefact', () => {
    const dist = join(base, 'selftest', 'apps', 'web', 'dist');
    const bundle = syntheticSet();
    plantFile(dist, 'assets/index-abc123.js', bundle);
    const shapes = ARTEFACT_SKIP_SHAPES.map((file) => ({ file, plants: shapePlants() }));
    for (const shape of shapes) plantFile(dist, shape.file, shape.plants);
    const result = runGitleaks({
      binary: options.binary,
      label: 'selftest-artefact',
      mode: 'dir',
      target: dist,
      config: artefactConfig,
      reportDir: options.reportDir,
    });
    const problems = [
      ...expectPlants('artefact', result, 'assets/index-abc123.js', bundle).problems,
      ...shapes.flatMap(
        (shape) => expectPlants('artefact', result, shape.file, shape.plants).problems,
      ),
    ];
    return { name: 'artefact', ok: problems.length === 0, problems: [...new Set(problems)] };
  });

  // canary: the canary rule fires under both configs, so each file (not gitleaks' built-in
  // default) was loaded.
  run('canary', () => {
    const problems: string[] = [];
    for (const [label, config] of [
      ['repo', repoConfig],
      ['artefacts', artefactConfig],
    ] as const) {
      const dir = join(base, `selftest-canary-${label}`);
      const plants: Plant[] = [{ rule: 'ralysa-selftest-canary', line: `x = "${canary()}"` }];
      plantFile(dir, 'canary.txt', plants);
      const result = runGitleaks({
        binary: options.binary,
        label: `selftest-canary-${label}`,
        mode: 'dir',
        target: dir,
        config,
        reportDir: options.reportDir,
      });
      problems.push(
        ...expectPlants(label, result, 'canary.txt', plants).problems.map((p) => `${label}: ${p}`),
      );
    }
    return { name: 'canary', ok: problems.length === 0, problems };
  });

  rmSync(base, { recursive: true, force: true });
  return results;
}
