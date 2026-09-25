// secret-scan: the one way gitleaks runs in CI and locally (F-001 design §6.2; AC-2;
// SEC-F001-05, -06, -20). Dependency-free (node:* and lib/core.ts only), because the CI
// `secret-scan` job has no install and no build.
//
// Every run:
// - re-hashes the gitleaks binary against tool-hashes.txt first, so a restored cache or a
//   tampered copy fails closed (SEC-F001-20);
// - passes the config explicitly, with --redact, --ignore-gitleaks-allow, --exit-code 1 and a
//   JSON report (SEC-F001-06);
// - refuses a target that holds a .gitleaksignore. gitleaks reads `<target>/.gitleaksignore`
//   even when --gitleaks-ignore-path points elsewhere (checked with 8.30.1), and that file would
//   be an allow-list outside the configs. --gitleaks-ignore-path points at an empty folder;
// - treats exit 0 as pass, 1 as findings, and anything else as a scanner error.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { type Finding, isRecord, listWorkspaceDirs, readJson } from './lib/core.ts';

export const REPO_CONFIG = '.gitleaks.toml';
export const ARTEFACT_CONFIG = '.gitleaks.artefacts.toml';
export const HASH_FILE = 'tooling/repo-scripts/bin/tool-hashes.txt';

/** The flags every gitleaks call carries, whatever the mode (design §6.2.2). */
export const FIXED_FLAGS = [
  '--redact',
  '--ignore-gitleaks-allow',
  '--exit-code',
  '1',
  '--report-format',
  'json',
  '--no-banner',
  '--log-level',
  'warn',
] as const;

export class SecretScanError extends Error {}

export interface ToolEntry {
  tool: string;
  version: string;
  platform: string;
  url: string;
  archiveSha256: string;
  binarySha256: string;
}

export interface LeakFinding {
  rule: string;
  file: string;
  line: number;
  commit?: string;
}

export interface ScanResult {
  label: string;
  exitCode: number;
  findings: LeakFinding[];
  reportPath: string;
}

/** The tool-hashes.txt platform name for this machine. */
export function currentPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'linux' && arch === 'x64') return 'linux_x64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin_arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin_x64';
  throw new SecretScanError(`unsupported platform ${platform}/${arch}`);
}

export function parseToolHashes(text: string): ToolEntry[] {
  const entries: ToolEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [tool, version, platform, url, archiveSha256, binarySha256, ...rest] = line.split(/\s+/);
    const hex = /^[0-9a-f]{64}$/;
    if (
      tool === undefined ||
      version === undefined ||
      platform === undefined ||
      url === undefined ||
      archiveSha256 === undefined ||
      binarySha256 === undefined ||
      rest.length > 0 ||
      !hex.test(archiveSha256) ||
      !hex.test(binarySha256)
    ) {
      throw new SecretScanError(`malformed tool-hashes.txt line: ${line}`);
    }
    entries.push({ tool, version, platform, url, archiveSha256, binarySha256 });
  }
  return entries;
}

export function toolEntry(root: string, tool: string, platform: string): ToolEntry {
  const matches = parseToolHashes(readFileSync(join(root, HASH_FILE), 'utf8')).filter(
    (entry) => entry.tool === tool && entry.platform === platform,
  );
  if (matches.length !== 1) {
    throw new SecretScanError(
      `tool-hashes.txt needs exactly one ${tool} entry for ${platform}, found ${String(matches.length)}`,
    );
  }
  return matches[0] as ToolEntry;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The path of the installed gitleaks binary after re-hashing it (SEC-F001-20). Throws if it is
 * missing or differs from tool-hashes.txt.
 */
export function verifiedGitleaks(root: string, platform = currentPlatform()): string {
  const entry = toolEntry(root, 'gitleaks', platform);
  const binary = join(root, '.tools', 'gitleaks', entry.version, 'gitleaks');
  if (!existsSync(binary)) {
    throw new SecretScanError(
      `gitleaks ${entry.version} is not installed at ${binary}; run pnpm tools:install (tooling/repo-scripts/bin/install-tool.sh gitleaks)`,
    );
  }
  const actual = sha256File(binary);
  if (actual !== entry.binarySha256) {
    throw new SecretScanError(
      `${binary} does not match tool-hashes.txt (expected ${entry.binarySha256}, got ${actual}); refusing to run it. Delete .tools/gitleaks and run pnpm tools:install.`,
    );
  }
  return binary;
}

export interface RunOptions {
  binary: string;
  label: string;
  mode: 'dir' | 'git';
  /** The directory scanned (dir) or the repository (git). */
  target: string;
  /** The config file; always passed explicitly. */
  config: string;
  /** git mode only: passed as --log-opts=<value>. */
  logOpts?: string;
  reportDir: string;
}

/** An empty folder for --gitleaks-ignore-path, so no .gitleaksignore is picked up from cwd. */
function emptyDir(reportDir: string): string {
  const dir = join(reportDir, '.no-gitleaksignore');
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length > 0) throw new SecretScanError(`${dir} must be empty`);
  return dir;
}

export function runGitleaks(options: RunOptions): ScanResult {
  const { binary, mode, target, config, reportDir } = options;
  if (!existsSync(config)) throw new SecretScanError(`config not found: ${config}`);
  if (!existsSync(target)) throw new SecretScanError(`scan target not found: ${target}`);
  if (existsSync(join(target, '.gitleaksignore'))) {
    throw new SecretScanError(
      `${join(target, '.gitleaksignore')} exists; gitleaks would use it as an allow-list outside the configs. Remove it.`,
    );
  }
  mkdirSync(reportDir, { recursive: true });
  const slug = options.label.replace(/[^A-Za-z0-9._-]+/g, '-');
  const reportPath = join(reportDir, `gitleaks-${slug}.json`);
  const args = [
    mode,
    ...(mode === 'dir' ? [target] : []),
    '--config',
    config,
    ...FIXED_FLAGS,
    '--report-path',
    reportPath,
    '--gitleaks-ignore-path',
    emptyDir(reportDir),
    ...(options.logOpts === undefined ? [] : [`--log-opts=${options.logOpts}`]),
  ];
  const result = spawnSync(binary, args, {
    cwd: mode === 'git' ? target : undefined,
    encoding: 'utf8',
    env: { ...process.env, GITLEAKS_CONFIG: '', GITLEAKS_CONFIG_TOML: '' },
  });
  const exitCode = result.status ?? -1;
  if (exitCode !== 0 && exitCode !== 1) {
    const tail = `${result.stderr}${result.stdout}`.trim().split('\n').slice(-5).join('\n');
    throw new SecretScanError(
      `gitleaks exited with ${String(exitCode)} (${result.error?.message ?? 'scanner error'}) for ${options.label}; only 0 and 1 are results\n${tail}`,
    );
  }
  const findings = readReport(reportPath, target, mode);
  if (exitCode === 1 && findings.length === 0) {
    throw new SecretScanError(`gitleaks exited 1 for ${options.label} but its report is empty`);
  }
  if (exitCode === 0 && findings.length > 0) {
    throw new SecretScanError(`gitleaks exited 0 for ${options.label} but reported findings`);
  }
  return { label: options.label, exitCode, findings, reportPath };
}

function readReport(reportPath: string, target: string, mode: 'dir' | 'git'): LeakFinding[] {
  if (!existsSync(reportPath)) throw new SecretScanError(`no report written at ${reportPath}`);
  const raw: unknown = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (!Array.isArray(raw)) throw new SecretScanError(`report is not a JSON array: ${reportPath}`);
  return raw.filter(isRecord).map((entry) => {
    const file = typeof entry.File === 'string' ? entry.File : '?';
    const shown = mode === 'dir' && isAbsolute(file) ? relative(target, file) : file;
    return {
      rule: typeof entry.RuleID === 'string' ? entry.RuleID : '?',
      file: shown,
      line: typeof entry.StartLine === 'number' ? entry.StartLine : 0,
      ...(typeof entry.Commit === 'string' && entry.Commit !== '' ? { commit: entry.Commit } : {}),
    };
  });
}

function git(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The number of commits in `base..head`. Throws when the range is empty or a SHA isn't in the
 * clone, so a PR scan can never pass by scanning nothing (SEC-F001-06).
 */
export function assertRange(repo: string, base: string, head: string): number {
  const sha = /^[0-9a-f]{7,64}$/;
  if (!sha.test(base) || !sha.test(head)) {
    throw new SecretScanError(`base and head must be commit SHAs (got "${base}", "${head}")`);
  }
  const result = git(repo, ['rev-list', '--count', `${base}..${head}`]);
  const count = Number.parseInt(result.stdout.trim(), 10);
  if (result.status !== 0 || !Number.isInteger(count) || count === 0) {
    throw new SecretScanError(
      `scan range is empty; is the base commit fetched? (git rev-list --count ${base}..${head}: ${result.status === 0 ? String(count) : result.stderr.trim()})`,
    );
  }
  return count;
}

/** Shipped artefact folders: every `ralysa.artefacts` path of every `shipped: true` workspace. */
export function shippedArtefacts(root: string): { workspace: string; path: string }[] {
  const out: { workspace: string; path: string }[] = [];
  for (const dir of listWorkspaceDirs(root)) {
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = readJson(manifest);
    const meta = isRecord(pkg) ? pkg.ralysa : undefined;
    if (!isRecord(meta) || meta.shipped !== true) continue;
    const artefacts = Array.isArray(meta.artefacts) ? meta.artefacts : ['dist'];
    for (const artefact of artefacts) {
      if (typeof artefact === 'string') out.push({ workspace: dir, path: `${dir}/${artefact}` });
    }
  }
  return out;
}

export interface ScanContext {
  root: string;
  binary: string;
  reportDir: string;
}

export function scanPr(ctx: ScanContext, base: string, head: string): ScanResult {
  assertRange(ctx.root, base, head);
  return runGitleaks({
    binary: ctx.binary,
    label: 'pr',
    mode: 'git',
    target: ctx.root,
    config: join(ctx.root, REPO_CONFIG),
    logOpts: `${base}..${head}`,
    reportDir: ctx.reportDir,
  });
}

export function scanTree(ctx: ScanContext): ScanResult {
  return runGitleaks({
    binary: ctx.binary,
    label: 'tree',
    mode: 'dir',
    target: ctx.root,
    config: join(ctx.root, REPO_CONFIG),
    reportDir: ctx.reportDir,
  });
}

export function scanHistory(ctx: ScanContext): ScanResult {
  return runGitleaks({
    binary: ctx.binary,
    label: 'history',
    mode: 'git',
    target: ctx.root,
    config: join(ctx.root, REPO_CONFIG),
    reportDir: ctx.reportDir,
  });
}

/**
 * Scans every shipped artefact with the allow-list-free config. A missing artefact path is an
 * error, so "0 findings" can't come from scanning nothing (AC-2).
 */
export function scanArtefacts(ctx: ScanContext): ScanResult[] {
  const artefacts = shippedArtefacts(ctx.root);
  const missing = artefacts.filter((a) => !existsSync(join(ctx.root, a.path)));
  if (missing.length > 0) {
    throw new SecretScanError(
      `shipped artefact path missing (build first): ${missing.map((a) => a.path).join(', ')}`,
    );
  }
  return artefacts.map((artefact) =>
    runGitleaks({
      binary: ctx.binary,
      label: `artefact-${artefact.path}`,
      mode: 'dir',
      target: join(ctx.root, artefact.path),
      config: join(ctx.root, ARTEFACT_CONFIG),
      reportDir: ctx.reportDir,
    }),
  );
}

/** Findings as the repo checks print them. The secret itself is never included. */
export function toFindings(result: ScanResult): Finding[] {
  return result.findings.map((finding) => ({
    rule: `secret/${finding.rule}`,
    path: `${finding.file}:${String(finding.line)}`,
    message: `${result.label}${finding.commit === undefined ? '' : ` commit ${finding.commit}`} (secret redacted; report ${result.reportPath})`,
  }));
}
