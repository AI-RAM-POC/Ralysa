// The static config gate (code review N1 follow-up). pnpm runs repository-controlled code the
// moment it starts: every pnpm command (even `pnpm --version`) installs `configDependencies` and
// loads the pnpmfiles of `pnpm-plugin-*` config dependencies, and `pnpm install` then runs
// lifecycle scripts and allowed dependency builds. So these checks run first, with Node built-ins
// only and no subprocess: in CI before any pnpm command (pre-install-gate.ts), and at the start
// of check-workspaces. Any finding here means "don't run pnpm on this tree yet".
//
// Imports are restricted to node:* and the dependency-free lib/core.ts and lib/mini-yaml.ts; a
// test runs this module from a folder with no node_modules to prove it.
import { createHash } from 'node:crypto';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import {
  type Finding,
  isRecord,
  listWorkspaceDirs,
  readJson,
  toPosix,
  walkFiles,
} from './lib/core.ts';
import { MiniYamlError, parseMiniYaml } from './lib/mini-yaml.ts';

/**
 * Scripts a package manager runs by itself during install or publish. `pnpm:devPreinstall` is
 * pnpm's root-only hook, run before every install of the workspace (code review M2).
 */
export const LIFECYCLE_SCRIPTS = [
  'pnpm:devPreinstall',
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepack',
  'postpack',
  'prepublish',
  'prepublishOnly',
  'publish',
  'postpublish',
] as const;

/** pnpm 11's `isPluginName`: config dependencies whose pnpmfile pnpm loads automatically. */
export function isPnpmPluginName(name: string): boolean {
  if (name.startsWith('pnpm-plugin-')) return true;
  if (!name.startsWith('@')) return false;
  return name.startsWith('@pnpm/plugin-') || name.includes('/pnpm-plugin-');
}

export const PNPMFILE = /(^|\/)\.?pnpmfile\.(c|m)?js$/;
const UNSUPPORTED_MANIFESTS = ['package.yaml', 'package.json5'];

// ---------------------------------------------------------------------------------------------
// Registers (validated by hand: no zod before install)

export interface LifecycleEntry {
  package: string;
  script: string;
  command: string;
  owner: string;
  reason: string;
}
export interface AllowBuildsEntry {
  package: string;
  reason: string;
  reviewer: string;
  date: string;
}
export interface PnpmfileEntry {
  path: string;
  sha256: string;
  owner: string;
  reason: string;
  date: string;
}
export interface ConfigDependencyEntry {
  package: string;
  specifier: string;
  owner: string;
  reason: string;
  date?: string;
}

type FieldRule = { required: boolean; pattern?: RegExp; oneOf?: readonly string[] };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text: FieldRule = { required: true };

const REGISTERS = {
  lifecycle: {
    file: 'lifecycle-allowlist.json',
    fields: {
      package: text,
      script: { required: true, oneOf: LIFECYCLE_SCRIPTS },
      command: text,
      owner: text,
      reason: text,
    },
  },
  allowBuilds: {
    file: 'allow-builds.json',
    fields: {
      package: text,
      reason: text,
      reviewer: text,
      date: { required: true, pattern: DATE },
    },
  },
  pnpmfile: {
    file: 'pnpmfile-allowlist.json',
    fields: {
      path: text,
      sha256: { required: true, pattern: /^[0-9a-f]{64}$/ },
      owner: text,
      reason: text,
      date: { required: true, pattern: DATE },
    },
  },
  configDependencies: {
    file: 'config-dependencies.json',
    fields: {
      package: text,
      specifier: { required: true, pattern: /^[^+\s]+\+sha512-[A-Za-z0-9+/=]+$/ },
      owner: text,
      reason: text,
      date: { required: false, pattern: DATE },
    },
  },
} as const satisfies Record<string, { file: string; fields: Record<string, FieldRule> }>;

function loadRegister<T>(dir: string, key: keyof typeof REGISTERS, findings: Finding[]): T[] {
  const { file, fields } = REGISTERS[key];
  const full = join(dir, file);
  const fail = (message: string): T[] => {
    findings.push({ rule: 'registers/schema', path: full, message });
    return [];
  };
  if (!existsSync(full)) {
    findings.push({ rule: 'registers/missing', path: full, message: 'register file is missing' });
    return [];
  }
  let data: unknown;
  try {
    data = readJson(full);
  } catch (error) {
    return fail(`not valid JSON: ${String(error)}`);
  }
  if (!isRecord(data) || !Array.isArray(data.entries)) return fail('expected { "entries": [...] }');
  const extraTop = Object.keys(data).filter((k) => k !== 'entries' && k !== '$comment');
  if (extraTop.length > 0) return fail(`unknown keys: ${extraTop.join(', ')}`);
  const rules: Record<string, FieldRule> = fields;
  for (const [index, entry] of (data.entries as unknown[]).entries()) {
    if (!isRecord(entry)) return fail(`entries[${String(index)}] is not an object`);
    for (const key of Object.keys(entry)) {
      if (!(key in rules)) return fail(`entries[${String(index)}].${key} is not allowed`);
    }
    for (const [name, rule] of Object.entries(rules)) {
      const value = entry[name];
      if (value === undefined && !rule.required) continue;
      if (typeof value !== 'string' || value.trim() === '') {
        return fail(`entries[${String(index)}].${name} must be a non-empty string`);
      }
      if (rule.pattern !== undefined && !rule.pattern.test(value)) {
        return fail(`entries[${String(index)}].${name} has the wrong format`);
      }
      if (rule.oneOf !== undefined && !rule.oneOf.includes(value)) {
        return fail(`entries[${String(index)}].${name} must be one of ${rule.oneOf.join(', ')}`);
      }
    }
  }
  return data.entries as T[];
}

// ---------------------------------------------------------------------------------------------
// Workspace globs

/**
 * Resolves pnpm-workspace.yaml `packages` globs to folders with a package.json, without pnpm
 * (code review m1; pnpm itself is never asked, see the note at the top of this file).
 */
export function resolveWorkspaceGlobs(root: string, packages: unknown): string[] {
  const globs = Array.isArray(packages)
    ? packages.filter((g): g is string => typeof g === 'string')
    : [];
  const include = globs.filter((g) => !g.startsWith('!')).map((g) => g.replace(/^\.\//, ''));
  const exclude = globs
    .filter((g) => g.startsWith('!'))
    .map((g) => g.slice(1).replace(/^\.\//, ''));
  if (include.length === 0) return [];
  const found = globSync(
    include.map((g) => `${g.replace(/\/+$/, '')}/package.json`),
    { cwd: root, exclude: (path: string) => /(^|\/)node_modules(\/|$)/.test(toPosix(path)) },
  )
    .map((file) => posix.dirname(toPosix(file)))
    .filter((dir) => dir !== '.');
  const excluded = new Set(
    exclude.length === 0
      ? []
      : globSync(exclude, { cwd: root }).map((dir) => toPosix(dir).replace(/\/+$/, '')),
  );
  return [...new Set(found)].filter((dir) => !excluded.has(dir)).sort();
}

// ---------------------------------------------------------------------------------------------
// The gate

export interface ConfigGateOptions {
  root: string;
  /** Folder with the registers; defaults to tooling/repo-scripts. */
  registersDir?: string;
}

export interface ConfigGateResult {
  findings: Finding[];
  /** pnpm-workspace.yaml as the gate read it (empty when it couldn't be read). */
  settings: Record<string, unknown>;
}

function readNpmrc(root: string): string {
  const file = join(root, '.npmrc');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function readManifest(
  root: string,
  dir: string,
  findings: Finding[],
): Record<string, unknown> | undefined {
  const file = join(root, dir, 'package.json');
  if (!existsSync(file)) return undefined;
  try {
    const pkg = readJson(file);
    return isRecord(pkg) ? pkg : undefined;
  } catch (error) {
    findings.push({
      rule: 'gate/manifest',
      path: dir === '' ? 'package.json' : `${dir}/package.json`,
      message: `can't be read, so its scripts can't be checked: ${String(error)}`,
    });
    return undefined;
  }
}

function specifierOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.version === 'string' && typeof value.integrity === 'string') {
    return `${value.version}+${value.integrity}`;
  }
  return JSON.stringify(value);
}

function checkConfigDependencies(
  settings: Record<string, unknown>,
  rootPkg: Record<string, unknown> | undefined,
  register: ConfigDependencyEntry[],
  findings: Finding[],
): void {
  const pnpmField = rootPkg?.pnpm;
  if (isRecord(pnpmField) && pnpmField.configDependencies !== undefined) {
    findings.push({
      rule: 'pnpm/config-dependencies',
      path: 'package.json',
      message:
        'pnpm.configDependencies in package.json is not allowed; config dependencies go in pnpm-workspace.yaml with a reviewed register entry',
    });
  }
  const deps = settings.configDependencies;
  if (deps === undefined || deps === null) return;
  if (!isRecord(deps)) {
    findings.push({
      rule: 'pnpm/config-dependencies',
      path: 'pnpm-workspace.yaml',
      message: 'configDependencies must be a mapping',
    });
    return;
  }
  for (const [name, value] of Object.entries(deps)) {
    const specifier = specifierOf(value);
    if (register.some((e) => e.package === name && e.specifier === specifier)) continue;
    const plugin = isPnpmPluginName(name)
      ? ' It is a pnpm plugin name, so pnpm also loads its pnpmfile and runs its hooks.'
      : '';
    findings.push({
      rule: 'pnpm/config-dependencies',
      path: 'pnpm-workspace.yaml',
      message: `configDependencies.${name} = "${specifier}" is not in tooling/repo-scripts/config-dependencies.json with this exact version and integrity; every pnpm command installs config dependencies before doing anything else.${plugin}`,
    });
  }
}

function checkPnpmfiles(
  root: string,
  settings: Record<string, unknown>,
  rootPkg: Record<string, unknown> | undefined,
  npmrc: string,
  register: PnpmfileEntry[],
  findings: Finding[],
): void {
  const candidates = new Set(walkFiles(root).filter((file) => PNPMFILE.test(file)));
  const named: [string, string, unknown][] = [
    ['pnpm-workspace.yaml', 'pnpmfile', settings.pnpmfile],
    ['pnpm-workspace.yaml', 'globalPnpmfile', settings.globalPnpmfile],
  ];
  const pnpmField = rootPkg?.pnpm;
  if (isRecord(pnpmField)) {
    named.push(['package.json', 'pnpm.pnpmfile', pnpmField.pnpmfile]);
    named.push(['package.json', 'pnpm.globalPnpmfile', pnpmField.globalPnpmfile]);
  }
  for (const match of npmrc.matchAll(/^\s*(global-pnpmfile|pnpmfile)\s*=\s*(.+?)\s*$/gim)) {
    named.push(['.npmrc', match[1] ?? 'pnpmfile', match[2]]);
  }
  for (const [file, setting, value] of named) {
    if (value === undefined || value === null) continue;
    if (/global/i.test(setting)) {
      findings.push({
        rule: 'pnpm/pnpmfile',
        path: file,
        message: `${setting} must not be set: a pnpmfile outside the repo can't be reviewed`,
      });
      continue;
    }
    for (const path of [value].flat()) {
      if (typeof path !== 'string') {
        findings.push({ rule: 'pnpm/pnpmfile', path: file, message: `${setting} must be a path` });
        continue;
      }
      const rel = posix.normalize(toPosix(path)).replace(/^\.\//, '');
      if (rel.startsWith('/') || rel.startsWith('..')) {
        findings.push({
          rule: 'pnpm/pnpmfile',
          path: file,
          message: `${setting} points outside the repository (${path}); it can't be reviewed`,
        });
      } else {
        candidates.add(rel);
      }
    }
  }
  for (const file of [...candidates].sort()) {
    const full = join(root, file);
    const entry = register.find((e) => e.path === file);
    const hash = existsSync(full)
      ? createHash('sha256').update(readFileSync(full)).digest('hex')
      : undefined;
    if (entry === undefined) {
      findings.push({
        rule: 'pnpm/pnpmfile',
        path: file,
        message:
          'pnpm runs this pnpmfile when it starts; it needs a reviewed entry in tooling/repo-scripts/pnpmfile-allowlist.json',
      });
    } else if (hash !== entry.sha256) {
      findings.push({
        rule: 'pnpm/pnpmfile',
        path: file,
        message: `content changed since review (sha256 ${hash ?? 'missing file'} ≠ ${entry.sha256}); review it again and update pnpmfile-allowlist.json`,
      });
    }
  }
}

function checkLifecycleScripts(
  where: string,
  pkg: Record<string, unknown>,
  register: LifecycleEntry[],
  findings: Finding[],
): void {
  const scripts = pkg.scripts;
  if (!isRecord(scripts)) return;
  const name = typeof pkg.name === 'string' ? pkg.name : where;
  for (const script of LIFECYCLE_SCRIPTS) {
    const command = scripts[script];
    if (command === undefined) continue;
    const allowed = register.some(
      (e) => e.package === name && e.script === script && e.command === command,
    );
    if (!allowed) {
      findings.push({
        rule: 'lifecycle/script',
        path: where === '' ? 'package.json' : `${where}/package.json`,
        message: `lifecycle script "${script}" is not in tooling/repo-scripts/lifecycle-allowlist.json (pnpm would run it on install; SEC-F001-11)`,
      });
    }
  }
}

function checkBuildSettings(
  root: string,
  settings: Record<string, unknown>,
  rootPkg: Record<string, unknown> | undefined,
  npmrc: string,
  register: AllowBuildsEntry[],
  findings: Finding[],
): void {
  const reviewed = new Set(register.map((e) => e.package));
  // Anything other than "absent" or false is treated as enabled, so an odd spelling can't slip by.
  if (settings.enablePrePostScripts !== undefined && settings.enablePrePostScripts !== false) {
    findings.push({
      rule: 'pnpm/enable-pre-post-scripts',
      path: 'pnpm-workspace.yaml',
      message: 'enablePrePostScripts must not be enabled (SEC-F001-19)',
    });
  }
  if (/^\s*enable-pre-post-scripts\s*=\s*(?!false\s*$)/im.test(npmrc)) {
    findings.push({
      rule: 'pnpm/enable-pre-post-scripts',
      path: '.npmrc',
      message: 'enable-pre-post-scripts must not be enabled (SEC-F001-19)',
    });
  }
  const builds = settings.allowBuilds;
  if (builds !== undefined && builds !== null && !isRecord(builds)) {
    findings.push({
      rule: 'pnpm/allow-builds',
      path: 'pnpm-workspace.yaml',
      message: 'allowBuilds must be a mapping',
    });
  } else if (isRecord(builds)) {
    for (const [pkg, value] of Object.entries(builds)) {
      if (value === false || reviewed.has(pkg)) continue;
      findings.push({
        rule: 'pnpm/allow-builds',
        path: 'pnpm-workspace.yaml',
        message: `allowBuilds["${pkg}"] is ${JSON.stringify(value)} without a reviewed entry in tooling/repo-scripts/allow-builds.json (SEC-F001-19)`,
      });
    }
  }
  const pnpmField = isRecord(rootPkg?.pnpm) ? rootPkg.pnpm : {};
  for (const [file, value] of [
    ['pnpm-workspace.yaml', settings.onlyBuiltDependencies],
    ['package.json', pnpmField.onlyBuiltDependencies],
  ] as const) {
    if (value === undefined || value === null) continue;
    const list = Array.isArray(value) ? value : [value];
    for (const pkg of list) {
      if (typeof pkg === 'string' && reviewed.has(pkg)) continue;
      findings.push({
        rule: 'pnpm/allow-builds',
        path: file,
        message: `onlyBuiltDependencies entry ${JSON.stringify(pkg)} lets a dependency build without a reviewed entry in tooling/repo-scripts/allow-builds.json`,
      });
    }
  }
  for (const file of ['pnpm-workspace.yaml', '.npmrc', 'package.json']) {
    const full = join(root, file);
    if (!existsSync(full)) continue;
    if (/dangerously-?allow-?all-?builds/i.test(readFileSync(full, 'utf8'))) {
      findings.push({
        rule: 'pnpm/dangerously-allow-all-builds',
        path: file,
        message: 'dangerouslyAllowAllBuilds must never be set (SEC-F001-19)',
      });
    }
  }
}

export function checkConfigGate(options: ConfigGateOptions): ConfigGateResult {
  const { root } = options;
  const registersDir = options.registersDir ?? join(root, 'tooling', 'repo-scripts');
  const findings: Finding[] = [];

  const lifecycle = loadRegister<LifecycleEntry>(registersDir, 'lifecycle', findings);
  const allowBuilds = loadRegister<AllowBuildsEntry>(registersDir, 'allowBuilds', findings);
  const pnpmfiles = loadRegister<PnpmfileEntry>(registersDir, 'pnpmfile', findings);
  const configDeps = loadRegister<ConfigDependencyEntry>(
    registersDir,
    'configDependencies',
    findings,
  );

  let settings: Record<string, unknown> = {};
  const workspaceFile = join(root, 'pnpm-workspace.yaml');
  try {
    settings = existsSync(workspaceFile) ? parseMiniYaml(readFileSync(workspaceFile, 'utf8')) : {};
  } catch (error) {
    if (!(error instanceof MiniYamlError)) throw error;
    findings.push({
      rule: 'gate/unsupported-yaml',
      path: 'pnpm-workspace.yaml',
      message: `${error.message}. The gate reads a strict YAML subset and fails closed, so no setting can hide from it.`,
    });
  }

  const npmrc = readNpmrc(root);
  const rootPkg = readManifest(root, '', findings);

  checkConfigDependencies(settings, rootPkg, configDeps, findings);
  checkPnpmfiles(root, settings, rootPkg, npmrc, pnpmfiles, findings);
  checkBuildSettings(root, settings, rootPkg, npmrc, allowBuilds, findings);

  // Lifecycle scripts in the root and in every folder pnpm could treat as a workspace.
  const dirs = new Set([
    ...listWorkspaceDirs(root),
    ...resolveWorkspaceGlobs(root, settings.packages),
  ]);
  if (rootPkg !== undefined) checkLifecycleScripts('', rootPkg, lifecycle, findings);
  for (const dir of ['', ...[...dirs].sort()]) {
    for (const manifest of UNSUPPORTED_MANIFESTS) {
      if (existsSync(join(root, dir, manifest))) {
        findings.push({
          rule: 'gate/manifest',
          path: dir === '' ? manifest : `${dir}/${manifest}`,
          message:
            'only package.json manifests are supported; pnpm would read this one and its scripts',
        });
      }
    }
    if (dir === '') continue;
    const pkg = readManifest(root, dir, findings);
    if (pkg !== undefined) checkLifecycleScripts(dir, pkg, lifecycle, findings);
  }

  return { findings, settings };
}
