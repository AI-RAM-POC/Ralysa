// Image and directory secret scans (F-002-T14; design §8.5, TC-F-002-14, -35; SEC-F002-13 c,
// SEC-F002-29, AR-12). Dependency-free like secret-scan.ts: node:* and the local modules only,
// so the `integration` job can run it with plain node.
//
// `image` checks a container image in four ways, and each must pass:
//   1. filesystem: the image is exported (`docker create` + `docker export`, every layer merged)
//      and the whole root filesystem is scanned with the allow-list-free artefact config;
//   2. config and history: `docker image inspect` (Env, Cmd, Entrypoint, Labels, User, ...) and
//      `docker history --no-trunc` (every instruction, ARG values included) are scanned the same
//      way, and must declare a non-root user and no secret-named ENV or ARG (SEC-F002-29);
//   3. exact values: every value of the `--exact-values` file (KEY=VALUE lines, for example the
//      dev stack's generated .env) is searched for, byte for byte, in all of the above;
//   4. exclusion: neither the dev stack nor the mock IdP's oidc-provider is in the image, by path
//      (node_modules, the pnpm virtual store), as a production dependency in any package.json, or
//      in any lockfile under the working directory (SEC-F002-13 c).
// A positive control fails the scan if the image's working directory has no package.json, so
// "0 findings" can't come from scanning the wrong tree.
//
// `dir` scans a directory (a DB dump, captured logs, a copy of deploy/**) with the artefact
// config and the same exact-value search; the integration suite uses it (TC-F-002-14, -20).
//
// Secret values are never printed: a finding names the KEY of the exact value and the file.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { type Finding, isRecord, toPosix } from './lib/core.ts';
import {
  ARTEFACT_CONFIG,
  type ScanContext,
  type ScanResult,
  SecretScanError,
  runGitleaks,
} from './secret-scan.ts';

/** The development-only packages that must not be in a shipped image (boundaries.js DEV_ONLY_PACKAGES). */
export const DEV_ONLY_IN_IMAGE = ['@ralysa/dev-stack', 'oidc-provider'] as const;

/** An exact value shorter than this could match by chance; the file is refused. */
export const MIN_EXACT_VALUE_LENGTH = 16;

/** ENV and ARG names that look like they carry a secret (SEC-F002-29). */
export const SECRET_NAME =
  /SECRET|PASS(?:WORD|WD|PHRASE)?\b|TOKEN|PRIVATE|CREDENTIAL|API[_-]?KEY|ACCESS[_-]?KEY|SECRET[_-]?ID|ROLE[_-]?ID/i;

export interface ExactValue {
  key: string;
  value: string;
}

/** Parses KEY=VALUE lines (comments, blanks and `export ` allowed; quotes stripped). */
export function parseExactValues(text: string, source = 'exact-values'): ExactValue[] {
  const values: ExactValue[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match === null) {
      throw new SecretScanError(`${source}:${String(index + 1)} is not a KEY=VALUE line`);
    }
    const key = match[1] as string;
    const value = (match[2] as string).replace(/^(["'])(.*)\1$/, '$2');
    if (value.length < MIN_EXACT_VALUE_LENGTH) {
      throw new SecretScanError(
        `${source}: the value of ${key} is shorter than ${String(MIN_EXACT_VALUE_LENGTH)} characters; an exact-value scan for it would match by chance`,
      );
    }
    values.push({ key, value });
  }
  if (values.length === 0) throw new SecretScanError(`${source} holds no values`);
  return values;
}

export function readExactValues(file: string): ExactValue[] {
  if (!existsSync(file)) throw new SecretScanError(`exact-values file not found: ${file}`);
  return parseExactValues(readFileSync(file, 'utf8'), file);
}

/** Every regular file under `dir` (posix, relative). Symlinks are not followed. */
export function regularFiles(dir: string, at = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const full = join(at, entry.name);
    if (entry.isDirectory()) files.push(...regularFiles(dir, full));
    else if (entry.isFile()) files.push(toPosix(relative(dir, full)));
  }
  return files.sort();
}

/** Byte-for-byte search for each exact value in every regular file under `dir`. */
export function scanExactValues(dir: string, values: ExactValue[], label: string): Finding[] {
  const needles = values.map((v) => ({ key: v.key, bytes: Buffer.from(v.value, 'utf8') }));
  const findings: Finding[] = [];
  for (const file of regularFiles(dir)) {
    let content: Buffer;
    try {
      content = readFileSync(join(dir, file));
    } catch (error) {
      throw new SecretScanError(`${label}: cannot read ${file}: ${String(error)}`);
    }
    for (const needle of needles) {
      if (content.includes(needle.bytes)) {
        findings.push({
          rule: `secret/exact-value`,
          path: file,
          message: `${label}: the value of ${needle.key} is in this file (value redacted)`,
        });
      }
    }
  }
  return findings;
}

/** A node_modules or pnpm virtual-store path of a development-only package. */
export function devOnlyPath(path: string): string | undefined {
  for (const name of DEV_ONLY_IN_IMAGE) {
    const store = name.replace('/', '+');
    if (
      path.includes(`node_modules/${name}/`) ||
      path.endsWith(`node_modules/${name}`) ||
      path.includes(`.pnpm/${store}@`)
    ) {
      return name;
    }
  }
  return undefined;
}

/** Every path (files, directories and links) under `dir`, posix and relative. */
function allPaths(dir: string, at = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const full = join(at, entry.name);
    out.push(toPosix(relative(dir, full)));
    if (entry.isDirectory()) out.push(...allPaths(dir, full));
  }
  return out;
}

const LOCKFILE =
  /(?:^|\/)(?:pnpm-lock\.yaml|lock\.yaml|\.modules\.yaml|package-lock\.json|yarn\.lock)$/;
const PACKAGE_JSON = /(?:^|\/)package\.json$/;
const PRODUCTION_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
] as const;

/**
 * The development-only packages a manifest or lockfile names as installed: a package.json's own
 * name or a production field (`pnpm deploy --prod` installs no devDependencies, and third-party
 * manifests list test tools such as oidc-provider there), or any mention in a lockfile, which
 * after `deploy --prod` holds the production closure only.
 */
export function devOnlyNamedIn(file: string, text: string): string[] {
  if (LOCKFILE.test(file)) return DEV_ONLY_IN_IMAGE.filter((name) => text.includes(name));
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return DEV_ONLY_IN_IMAGE.filter((name) => text.includes(name));
  }
  if (!isRecord(pkg)) return [];
  const names = new Set<string>(typeof pkg.name === 'string' ? [pkg.name] : []);
  for (const field of PRODUCTION_FIELDS) {
    const value: unknown = pkg[field];
    if (isRecord(value)) for (const key of Object.keys(value)) names.add(key);
    if (Array.isArray(value)) {
      for (const key of value) if (typeof key === 'string') names.add(key);
    }
  }
  return DEV_ONLY_IN_IMAGE.filter((name) => names.has(name));
}

/**
 * SEC-F002-13 (c): the dev stack and oidc-provider are nowhere in the root filesystem, and no
 * package manifest or lockfile under the working directory names them. Also the positive
 * control: the working directory holds the application's package.json.
 */
export function checkDevOnlyAbsent(rootfs: string, workingDir: string): Finding[] {
  const findings: Finding[] = [];
  const reported = new Set<string>();
  for (const path of allPaths(rootfs)) {
    const name = devOnlyPath(path);
    if (name === undefined || reported.has(name)) continue;
    reported.add(name);
    findings.push({
      rule: 'image/dev-only',
      path: `/${path}`,
      message: `${name} is in the image; the dev stack and the mock IdP must never ship (SEC-F002-13 c, AR-12)`,
    });
  }
  const app = join(rootfs, workingDir.replace(/^\/+/, ''));
  if (workingDir === '' || !existsSync(join(app, 'package.json'))) {
    findings.push({
      rule: 'image/positive-control',
      path: workingDir === '' ? '(no WorkingDir)' : workingDir,
      message:
        "the image's working directory has no package.json, so the scan can't show the application is clean; set WORKDIR to the application",
    });
    return findings;
  }
  const manifests = regularFiles(app).filter((f) => LOCKFILE.test(f) || PACKAGE_JSON.test(f));
  for (const file of manifests) {
    for (const name of devOnlyNamedIn(file, readFileSync(join(app, file), 'utf8'))) {
      findings.push({
        rule: 'image/dev-only',
        path: `${workingDir.replace(/\/+$/, '')}/${file}`,
        message: `names ${name} as installed; the production closure must not include it (SEC-F002-13 c)`,
      });
    }
  }
  return findings;
}

export interface ImageConfig {
  User?: string;
  Env?: string[];
  WorkingDir?: string;
  [key: string]: unknown;
}

/** Non-root user, no secret-named ENV, no secret-named ARG in the history (SEC-F002-29). */
export function checkImageConfig(config: ImageConfig, history: string[]): Finding[] {
  const findings: Finding[] = [];
  const user = (config.User ?? '').trim();
  const [name = '', group = ''] = user.split(':');
  if (name === '' || name === 'root' || name === '0' || group === '0' || group === 'root') {
    findings.push({
      rule: 'image/root-user',
      path: 'Config.User',
      message: `the image runs as "${user === '' ? 'root (unset)' : user}"; set a non-root USER (numeric uid:gid)`,
    });
  }
  for (const entry of config.Env ?? []) {
    const key = entry.split('=')[0] ?? '';
    if (SECRET_NAME.test(key)) {
      findings.push({
        rule: 'image/secret-env',
        path: `Config.Env ${key}`,
        message:
          'an ENV name that looks like a secret; never pass a secret through ENV or ARG (use BuildKit --mount=type=secret, or runtime injection from the vault)',
      });
    }
  }
  for (const [index, line] of history.entries()) {
    // BuildKit records `ARG NAME=value`, and prefixes RUN lines with `|n NAME=value ...`.
    const args = [
      ...line.matchAll(/(?:^|\s)ARG\s+([A-Za-z_][A-Za-z0-9_]*)/g),
      ...line.matchAll(/^\|\d+\s+((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+)/g),
    ].flatMap((match) =>
      (match[1] ?? '')
        .trim()
        .split(/\s+/)
        .map((pair) => pair.split('=')[0] ?? ''),
    );
    for (const arg of args) {
      if (SECRET_NAME.test(arg)) {
        findings.push({
          rule: 'image/secret-arg',
          path: `history[${String(index)}] ${arg}`,
          message:
            'a build ARG that looks like a secret; ARG values stay in the image history (SEC-F002-29)',
        });
      }
    }
  }
  return findings;
}

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type Docker = (args: string[], options?: { inherit?: boolean }) => CommandResult;

export const docker: Docker = (args, options = {}) => {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.inherit === true ? ['ignore', 'inherit', 'inherit'] : 'pipe',
  });
  if (result.error !== undefined) {
    throw new SecretScanError(`docker ${args[0] ?? ''}: ${result.error.message}`);
  }
  // With inherited stdio, Node sets stdout and stderr to null despite the string typing.
  const stdout = result.stdout as string | null;
  const stderr = result.stderr as string | null;
  return { status: result.status ?? -1, stdout: stdout ?? '', stderr: stderr ?? '' };
};

function must(run: Docker, args: string[], what: string, inherit = false): string {
  const result = run(args, { inherit });
  if (result.status !== 0) {
    throw new SecretScanError(
      `${what} failed (docker ${args[0] ?? ''} exited ${String(result.status)}): ${result.stderr.trim().split('\n').slice(-5).join('\n')}`,
    );
  }
  return result.stdout;
}

export interface ImageScanOptions {
  ctx: ScanContext;
  /** An image to scan as is. */
  image?: string;
  /** A Dockerfile to build first (context: the repository root), then scan. */
  dockerfile?: string;
  exactValuesFile?: string;
  docker?: Docker;
  /** Where the root filesystem is unpacked; defaults to $RUNNER_TEMP or the OS temp folder. */
  workDir?: string;
}

export interface ImageScanResult {
  image: string;
  results: ScanResult[];
  findings: Finding[];
}

/** Builds (if asked) and scans an image. Throws SecretScanError on any tool failure. */
export function scanImage(options: ImageScanOptions): ImageScanResult {
  const run = options.docker ?? docker;
  const { ctx } = options;
  const values =
    options.exactValuesFile === undefined ? [] : readExactValues(options.exactValuesFile);
  let image = options.image;
  let built = false;
  if (image === undefined) {
    if (options.dockerfile === undefined) {
      throw new SecretScanError('image: pass --image <ref> or --dockerfile <path>');
    }
    image = `ralysa-secret-scan:${randomBytes(6).toString('hex')}`;
    must(run, ['build', '-f', options.dockerfile, '-t', image, ctx.root], 'docker build', true);
    built = true;
  }
  const work = mkdtempSync(
    join(options.workDir ?? process.env.RUNNER_TEMP ?? tmpdir(), 'ralysa-image-scan-'),
  );
  let container: string | undefined;
  try {
    // 2. Config and history.
    const inspected: unknown = JSON.parse(
      must(run, ['image', 'inspect', image], 'docker image inspect'),
    );
    const first: unknown = Array.isArray(inspected) ? inspected[0] : undefined;
    if (!isRecord(first) || !isRecord(first.Config)) {
      throw new SecretScanError(`docker image inspect ${image} returned no Config`);
    }
    const config = first.Config as ImageConfig;
    const history = must(
      run,
      ['history', '--no-trunc', '--format', '{{.CreatedBy}}', image],
      'docker history',
    )
      .split('\n')
      .filter((line) => line.trim() !== '');
    const meta = join(work, 'meta');
    mkdirSync(meta, { recursive: true });
    writeFileSync(join(meta, 'image-config.json'), `${JSON.stringify(config, null, 2)}\n`);
    writeFileSync(join(meta, 'image-history.txt'), `${history.join('\n')}\n`);

    // 1. Filesystem: every layer merged, as the container sees it.
    container = must(run, ['create', image], 'docker create').trim();
    const tar = join(work, 'rootfs.tar');
    must(run, ['export', '--output', tar, container], 'docker export');
    const rootfs = join(work, 'rootfs');
    mkdirSync(rootfs, { recursive: true });
    const untar = spawnSync(
      'tar',
      ['-xf', tar, '-C', rootfs, '--no-same-owner', '--exclude', 'dev/*'],
      {
        encoding: 'utf8',
      },
    );
    if (untar.status !== 0) {
      throw new SecretScanError(`tar -xf of the exported image failed: ${untar.stderr.trim()}`);
    }
    rmSync(tar, { force: true });

    const results = [
      runGitleaks({
        binary: ctx.binary,
        label: 'image-filesystem',
        mode: 'dir',
        target: rootfs,
        config: join(ctx.root, ARTEFACT_CONFIG),
        reportDir: ctx.reportDir,
      }),
      runGitleaks({
        binary: ctx.binary,
        label: 'image-config-history',
        mode: 'dir',
        target: meta,
        config: join(ctx.root, ARTEFACT_CONFIG),
        reportDir: ctx.reportDir,
      }),
    ];
    const findings = [
      ...checkImageConfig(config, history),
      ...checkDevOnlyAbsent(rootfs, config.WorkingDir ?? ''),
      ...(values.length === 0
        ? []
        : [
            ...scanExactValues(rootfs, values, 'image-filesystem'),
            ...scanExactValues(meta, values, 'image-config-history'),
          ]),
    ];
    return { image, results, findings };
  } finally {
    if (container !== undefined) run(['rm', '-f', container]);
    if (built) run(['image', 'rm', '-f', image]);
    rmSync(work, { recursive: true, force: true });
  }
}

/** The artefact config and the exact-value search over one directory (a DB dump, logs, deploy/**). */
export function scanDirectory(
  ctx: ScanContext,
  dir: string,
  exactValuesFile?: string,
): { results: ScanResult[]; findings: Finding[] } {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) {
    throw new SecretScanError(`scan target is not a directory: ${dir}`);
  }
  if (regularFiles(dir).length === 0) {
    throw new SecretScanError(`scan target ${dir} holds no files; refusing to report 0 findings`);
  }
  const values = exactValuesFile === undefined ? [] : readExactValues(exactValuesFile);
  return {
    results: [
      runGitleaks({
        binary: ctx.binary,
        label: `dir-${basename(dir)}`,
        mode: 'dir',
        target: dir,
        config: join(ctx.root, ARTEFACT_CONFIG),
        reportDir: ctx.reportDir,
      }),
    ],
    findings: scanExactValues(dir, values, 'dir'),
  };
}
