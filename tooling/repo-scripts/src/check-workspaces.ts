// check-workspaces (F-001 design §2.1, §3.1; SEC-F001-09 a, -11, -19, -26; RC-7; AR-3).
// Fails when a workspace folder isn't a real pnpm workspace with the four required scripts, when
// a package.json breaks the workspace contract, when a lifecycle script or an unreviewed
// dependency build appears, when a dependency specifier could pull code from outside the
// registry (or from packs/), or when Python files appear before the F-004 toolchain exists.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import type { z } from 'zod';
import { SPECIFIER_ALLOWLIST } from '@ralysa/eslint-config/boundaries';
import {
  AllowBuildsRegister,
  LIFECYCLE_SCRIPTS,
  LifecycleAllowlist,
  REQUIRED_SCRIPTS,
  WorkspacePackageJson,
} from './contracts/workspace.ts';
import {
  type Finding,
  isRecord,
  listPnpmWorkspaces,
  listRepoFiles,
  listWorkspaceDirs,
  readJson,
  readYaml,
  toPosix,
} from './lib/repo.ts';

export interface SpecifierException {
  workspace: string;
  dependency: string;
  specifier: string;
  reason: string;
}

export interface CheckWorkspacesOptions {
  root: string;
  /** Workspace dirs as pnpm resolves them; defaults to `pnpm ls -r`. */
  pnpmWorkspaces?: string[];
  /** Repo files (posix, relative); defaults to git's tracked + untracked-not-ignored files. */
  repoFiles?: string[];
  /** Reviewed exotic-specifier exceptions; defaults to boundaries.js SPECIFIER_ALLOWLIST. */
  specifierAllowlist?: SpecifierException[];
  /** Folder that holds lifecycle-allowlist.json and allow-builds.json. */
  registersDir?: string;
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

const PYTHON_FILE =
  /(^|\/)(?:[^/]+\.py|pyproject\.toml|requirements[^/]*\.txt|Pipfile|setup\.cfg|uv\.lock)$/;
const PYTHON_ALLOWED_UNDER = ['docs/', 'requirements/'];

/** Specifier forms that can fetch code from outside the registry or from the local disk. */
export function exoticSpecifierKind(specifier: string): string | undefined {
  const s = specifier.trim();
  if (s.startsWith('npm:')) return 'npm: alias';
  if (s.startsWith('file:')) return 'file:';
  if (s.startsWith('link:')) return 'link:';
  if (s.startsWith('portal:')) return 'portal:';
  if (/^git(\+[a-z]+)?:/.test(s) || s.startsWith('git@')) return 'git';
  if (/^(github|gitlab|bitbucket|gist):/.test(s)) return 'hosted git';
  if (/^https?:\/\//.test(s)) return 'tarball URL';
  // "owner/repo" or "owner/repo#ref" is GitHub shorthand, not a semver range.
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(s)) return 'GitHub shorthand';
  if (s.startsWith('.') || s.startsWith('/')) return 'local path';
  return undefined;
}

/** The local path a file:, link:, portal: or bare-path specifier points at, if any. */
function localTarget(specifier: string): string | undefined {
  const s = specifier.trim();
  const prefixed = /^(?:file|link|portal):(.*)$/.exec(s);
  if (prefixed) return prefixed[1];
  return /^[./]/.test(s) ? s : undefined;
}

function resolvesUnderPacks(workspaceDir: string, specifier: string): boolean {
  const target = localTarget(specifier);
  if (target === undefined) return false;
  if (target.startsWith('/')) return /(^|\/)packs(\/|$)/.test(target);
  const resolved = posix.normalize(posix.join(workspaceDir === '' ? '.' : workspaceDir, target));
  return resolved === 'packs' || resolved.startsWith('packs/');
}

function checkSpecifiers(
  where: string,
  pkg: Record<string, unknown>,
  internalNames: Map<string, string>,
  allowlist: SpecifierException[],
  findings: Finding[],
): void {
  const manifest = where === '' ? 'package.json' : `${where}/package.json`;
  const groups: [string, unknown][] = DEPENDENCY_FIELDS.map((field) => [field, pkg[field]]);
  const pnpmField = pkg.pnpm;
  if (isRecord(pnpmField)) groups.push(['pnpm.overrides', pnpmField.overrides]);
  groups.push(['overrides', pkg.overrides], ['resolutions', pkg.resolutions]);

  for (const [field, deps] of groups) {
    if (!isRecord(deps)) continue;
    for (const [name, raw] of Object.entries(deps)) {
      if (typeof raw !== 'string') continue;
      const specifier = raw;
      if (resolvesUnderPacks(where, specifier)) {
        findings.push({
          rule: 'deps/packs',
          path: manifest,
          message: `${field}.${name} = "${specifier}" resolves under packs/; packs are never part of the build graph (RF-7, SEC-F001-26)`,
        });
        continue;
      }
      if (name.startsWith('@ralysa/') && field !== 'peerDependencies') {
        if (specifier !== 'workspace:*') {
          findings.push({
            rule: 'deps/internal-workspace-protocol',
            path: manifest,
            message: `${field}.${name} must be "workspace:*" so an @ralysa name can never resolve from the public registry (design §3.1)`,
          });
        }
        const kind = internalNames.get(name);
        if (kind === 'tooling' && field !== 'devDependencies') {
          findings.push({
            rule: 'deps/tooling-dev-only',
            path: manifest,
            message: `${name} is a tooling package and may appear only in devDependencies (AR-3)`,
          });
        }
        continue;
      }
      const kind = exoticSpecifierKind(specifier);
      if (kind === undefined) continue;
      const excepted = allowlist.some(
        (entry) =>
          entry.workspace === (where === '' ? '.' : where) &&
          entry.dependency === name &&
          entry.specifier === specifier,
      );
      if (!excepted) {
        findings.push({
          rule: 'deps/exotic-specifier',
          path: manifest,
          message: `${field}.${name} = "${specifier}" uses a ${kind} specifier; only registry versions, "catalog:" and "workspace:*" are allowed unless boundaries.js SPECIFIER_ALLOWLIST lists it with a reason (SEC-F001-09 a)`,
        });
      }
    }
  }
}

function checkLifecycleScripts(
  where: string,
  pkg: Record<string, unknown>,
  allowlist: LifecycleRegister,
  findings: Finding[],
): void {
  const scripts = pkg.scripts;
  if (!isRecord(scripts)) return;
  const name = typeof pkg.name === 'string' ? pkg.name : where;
  for (const script of LIFECYCLE_SCRIPTS) {
    const command = scripts[script];
    if (command === undefined) continue;
    const allowed = allowlist.entries.some(
      (entry) => entry.package === name && entry.script === script && entry.command === command,
    );
    if (!allowed) {
      findings.push({
        rule: 'lifecycle/script',
        path: where === '' ? 'package.json' : `${where}/package.json`,
        message: `lifecycle script "${script}" is not in tooling/repo-scripts/lifecycle-allowlist.json (it would run on every pnpm install; SEC-F001-11)`,
      });
    }
  }
}

type LifecycleRegister = z.infer<typeof LifecycleAllowlist>;

function loadRegister<T>(
  file: string,
  schema: { parse: (value: unknown) => T },
  findings: Finding[],
): T | undefined {
  if (!existsSync(file)) {
    findings.push({ rule: 'registers/missing', path: file, message: 'register file is missing' });
    return undefined;
  }
  try {
    return schema.parse(readJson(file));
  } catch (error) {
    findings.push({ rule: 'registers/schema', path: file, message: String(error) });
    return undefined;
  }
}

function checkPnpmSettings(root: string, allowBuilds: string[], findings: Finding[]): void {
  const workspaceFile = join(root, 'pnpm-workspace.yaml');
  const settings = readYaml(workspaceFile);
  if (!isRecord(settings)) {
    findings.push({
      rule: 'pnpm/settings',
      path: 'pnpm-workspace.yaml',
      message: 'not a YAML mapping',
    });
    return;
  }

  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  if (packages.some((glob) => typeof glob === 'string' && /^(\.\/)?packs(\/|$)/.test(glob))) {
    findings.push({
      rule: 'pnpm/packs-in-workspace',
      path: 'pnpm-workspace.yaml',
      message: 'packs/* must not be a workspace glob (RF-7)',
    });
  }

  if (settings.enablePrePostScripts === true) {
    findings.push({
      rule: 'pnpm/enable-pre-post-scripts',
      path: 'pnpm-workspace.yaml',
      message: 'enablePrePostScripts must not be true (SEC-F001-19)',
    });
  }

  if (settings.strictDepBuilds === false) {
    findings.push({
      rule: 'pnpm/strict-dep-builds',
      path: 'pnpm-workspace.yaml',
      message: 'strictDepBuilds must not be turned off (RF-3)',
    });
  }

  const builds = settings.allowBuilds;
  if (builds !== undefined && !isRecord(builds)) {
    findings.push({
      rule: 'pnpm/allow-builds',
      path: 'pnpm-workspace.yaml',
      message: 'allowBuilds must be a mapping',
    });
  } else if (builds !== undefined) {
    for (const [pkg, value] of Object.entries(builds)) {
      if (value === false) continue;
      if (!allowBuilds.includes(pkg)) {
        findings.push({
          rule: 'pnpm/allow-builds',
          path: 'pnpm-workspace.yaml',
          message: `allowBuilds["${pkg}"] is ${JSON.stringify(value)} without a reviewed entry in tooling/repo-scripts/allow-builds.json (SEC-F001-19)`,
        });
      }
    }
  }

  // dangerouslyAllowAllBuilds is banned in every place pnpm reads settings from.
  for (const file of ['pnpm-workspace.yaml', '.npmrc', 'package.json']) {
    const full = join(root, file);
    if (!existsSync(full)) continue;
    if (
      /dangerouslyAllowAllBuilds|dangerously-allow-all-builds/i.test(readFileSync(full, 'utf8'))
    ) {
      findings.push({
        rule: 'pnpm/dangerously-allow-all-builds',
        path: file,
        message: 'dangerouslyAllowAllBuilds must never be set (SEC-F001-19)',
      });
    }
  }
  const npmrc = join(root, '.npmrc');
  if (
    existsSync(npmrc) &&
    /^\s*enable-pre-post-scripts\s*=\s*true/im.test(readFileSync(npmrc, 'utf8'))
  ) {
    findings.push({
      rule: 'pnpm/enable-pre-post-scripts',
      path: '.npmrc',
      message: 'enable-pre-post-scripts must not be true (SEC-F001-19)',
    });
  }
}

function checkPython(repoFiles: string[], findings: Finding[]): void {
  for (const file of repoFiles) {
    if (!PYTHON_FILE.test(file)) continue;
    if (PYTHON_ALLOWED_UNDER.some((prefix) => file.startsWith(prefix))) continue;
    findings.push({
      rule: 'python/file',
      path: file,
      message: `Python files are not allowed until the F-004 design lands the Python lint, test and SR-03 ban (RC-7, OQ-D11): ${basename(file)}`,
    });
  }
}

export function checkWorkspaces(options: CheckWorkspacesOptions): Finding[] {
  const { root } = options;
  const registersDir = options.registersDir ?? join(root, 'tooling', 'repo-scripts');
  const findings: Finding[] = [];

  const lifecycle = loadRegister(
    join(registersDir, 'lifecycle-allowlist.json'),
    LifecycleAllowlist,
    findings,
  ) ?? {
    entries: [],
  };
  const allowBuilds = loadRegister(
    join(registersDir, 'allow-builds.json'),
    AllowBuildsRegister,
    findings,
  ) ?? {
    entries: [],
  };

  const dirs = listWorkspaceDirs(root);
  const pnpmWorkspaces = new Set(options.pnpmWorkspaces ?? listPnpmWorkspaces(root));
  const packages = new Map<string, Record<string, unknown>>();

  for (const dir of dirs) {
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) {
      findings.push({
        rule: 'workspace/missing-package-json',
        path: dir,
        message: `every folder under apps/, packages/, services/ and tooling/ must be a workspace; convert it with "pnpm scaffold ${dir} --kind <library|library-isomorphic|service|app|cli>"`,
      });
      continue;
    }
    let pkg: unknown;
    try {
      pkg = readJson(manifest);
    } catch (error) {
      findings.push({
        rule: 'workspace/schema',
        path: `${dir}/package.json`,
        message: String(error),
      });
      continue;
    }
    if (!isRecord(pkg)) continue;
    packages.set(dir, pkg);

    if (!pnpmWorkspaces.has(dir)) {
      findings.push({
        rule: 'workspace/not-in-pnpm',
        path: dir,
        message:
          'has a package.json but pnpm does not list it as a workspace (check pnpm-workspace.yaml)',
      });
    }

    const scripts = isRecord(pkg.scripts) ? pkg.scripts : {};
    for (const script of REQUIRED_SCRIPTS) {
      if (typeof scripts[script] !== 'string' || scripts[script] === '') {
        findings.push({
          rule: 'workspace/missing-script',
          path: `${dir}/package.json`,
          message: `missing the "${script}" script; Turbo silently skips a workspace without it (AC-1)`,
        });
      }
    }

    const parsed = WorkspacePackageJson.safeParse(pkg);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'scripts') continue; // reported above with a clearer message
        findings.push({
          rule: 'workspace/schema',
          path: `${dir}/package.json`,
          message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        });
      }
    }
  }

  const internalNames = new Map<string, string>();
  for (const pkg of packages.values()) {
    const meta = pkg.ralysa;
    if (typeof pkg.name === 'string' && isRecord(meta) && typeof meta.kind === 'string') {
      internalNames.set(pkg.name, meta.kind);
    }
  }

  const allowlist = options.specifierAllowlist ?? SPECIFIER_ALLOWLIST;
  const rootPkg = readJson(join(root, 'package.json'));
  const everyManifest: [string, Record<string, unknown>][] = [
    ...(isRecord(rootPkg) ? [['', rootPkg] as [string, Record<string, unknown>]] : []),
    ...packages.entries(),
  ];
  for (const [where, pkg] of everyManifest) {
    checkLifecycleScripts(where, pkg, lifecycle, findings);
    checkSpecifiers(where, pkg, internalNames, allowlist, findings);
  }

  checkPnpmSettings(
    root,
    allowBuilds.entries.map((entry) => entry.package),
    findings,
  );
  checkPython((options.repoFiles ?? listRepoFiles(root)).map(toPosix), findings);

  return findings;
}
