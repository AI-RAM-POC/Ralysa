// check-workspaces (F-001 design §2.1, §3.1; SEC-F001-09 a, -11, -19, -26; RC-7; AR-3).
// It starts with the static config gate (config-gate.ts: configDependencies, pnpmfiles, lifecycle
// scripts, dependency build settings) and stops there if the gate has findings. It never starts
// pnpm: every pnpm command installs configDependencies and loads pnpmfiles, so asking pnpm for
// the workspace list would run the very code this check exists to stop (code review N1
// follow-up). Workspaces come from resolving the pnpm-workspace.yaml globs directly.
// After the gate it fails when a workspace folder isn't a real workspace with the four required
// scripts, when a package.json breaks the workspace contract, when a dependency specifier (in a
// package.json or a pnpm-workspace.yaml catalog or override) could pull code from outside the
// registry or from packs/, or when Python files appear before the F-004 toolchain exists.
import { basename, join, posix } from 'node:path';
import { SPECIFIER_ALLOWLIST } from '@ralysa/eslint-config/boundaries';
import { checkConfigGate, resolveWorkspaceGlobs } from './config-gate.ts';
import { REQUIRED_SCRIPTS, WorkspacePackageJson } from './contracts/workspace.ts';
import { LONE_CR, parseMiniYaml } from './lib/mini-yaml.ts';
import {
  type Finding,
  isRecord,
  listRepoFiles,
  listWorkspaceDirs,
  readJson,
  readYaml,
  toPosix,
} from './lib/repo.ts';
import { existsSync, readFileSync } from 'node:fs';

export interface SpecifierException {
  workspace: string;
  dependency: string;
  specifier: string;
  reason: string;
}

export interface CheckWorkspacesOptions {
  root: string;
  /** Repo files (posix, relative); defaults to git's tracked + untracked-not-ignored files. */
  repoFiles?: string[];
  /** Reviewed exotic-specifier exceptions; defaults to boundaries.js SPECIFIER_ALLOWLIST. */
  specifierAllowlist?: SpecifierException[];
  /** Folder that holds the registers (lifecycle-allowlist.json, allow-builds.json, ...). */
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

/**
 * Checks one specifier value against the packs/ and exotic-specifier rules. `workspace` is the
 * allow-list key ("." for the root, "pnpm-workspace.yaml" for catalogs and overrides there) and
 * `baseDir` the folder a relative path resolves from. Returns true when a finding was added.
 */
function checkSpecifierValue(
  location: { file: string; workspace: string; baseDir: string },
  field: string,
  name: string,
  specifier: string,
  allowlist: SpecifierException[],
  findings: Finding[],
): boolean {
  if (resolvesUnderPacks(location.baseDir, specifier)) {
    findings.push({
      rule: 'deps/packs',
      path: location.file,
      message: `${field}.${name} = "${specifier}" resolves under packs/; packs are never part of the build graph (RF-7, SEC-F001-26)`,
    });
    return true;
  }
  const kind = exoticSpecifierKind(specifier);
  if (kind === undefined) return false;
  const excepted = allowlist.some(
    (entry) =>
      entry.workspace === location.workspace &&
      entry.dependency === name &&
      entry.specifier === specifier,
  );
  if (excepted) return false;
  findings.push({
    rule: 'deps/exotic-specifier',
    path: location.file,
    message: `${field}.${name} = "${specifier}" uses a ${kind} specifier; only registry versions, "catalog:" and "workspace:*" are allowed unless boundaries.js SPECIFIER_ALLOWLIST lists it with a reason (SEC-F001-09 a)`,
  });
  return true;
}

function checkSpecifiers(
  where: string,
  pkg: Record<string, unknown>,
  internalNames: Map<string, string>,
  allowlist: SpecifierException[],
  findings: Finding[],
): void {
  const manifest = where === '' ? 'package.json' : `${where}/package.json`;
  const location = { file: manifest, workspace: where === '' ? '.' : where, baseDir: where };
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
        checkSpecifierValue(location, field, name, specifier, allowlist, findings);
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
      checkSpecifierValue(location, field, name, specifier, allowlist, findings);
    }
  }
}

/**
 * pnpm-workspace.yaml can also define where packages come from: `catalog`, the named
 * `catalogs.<name>` and `overrides`. A "catalog:" reference in a package.json is only as safe as
 * the catalog value behind it, and pnpm 11 resolves npm:, git and tarball values there (code
 * review M1), so every value goes through the same rules as a package.json specifier.
 */
function checkWorkspaceSpecifiers(
  settings: Record<string, unknown>,
  allowlist: SpecifierException[],
  findings: Finding[],
): void {
  const location = { file: 'pnpm-workspace.yaml', workspace: 'pnpm-workspace.yaml', baseDir: '' };
  const groups: [string, unknown][] = [
    ['catalog', settings.catalog],
    ['overrides', settings.overrides],
  ];
  if (isRecord(settings.catalogs)) {
    for (const [catalog, entries] of Object.entries(settings.catalogs)) {
      groups.push([`catalogs.${catalog}`, entries]);
    }
  } else if (settings.catalogs !== undefined) {
    findings.push({
      rule: 'pnpm/settings',
      path: 'pnpm-workspace.yaml',
      message: 'catalogs must be a mapping of catalog name to entries',
    });
  }
  for (const [field, entries] of groups) {
    if (entries === undefined || entries === null) continue;
    if (!isRecord(entries)) {
      findings.push({
        rule: 'pnpm/settings',
        path: 'pnpm-workspace.yaml',
        message: `${field} must be a mapping`,
      });
      continue;
    }
    for (const [name, value] of Object.entries(entries)) {
      const specifier = typeof value === 'string' ? value : String(value);
      checkSpecifierValue(location, field, name, specifier, allowlist, findings);
    }
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

function checkWorkspaceSettings(settings: Record<string, unknown>, findings: Finding[]): void {
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  if (packages.some((glob) => typeof glob === 'string' && /^(\.\/)?packs(\/|$)/.test(glob))) {
    findings.push({
      rule: 'pnpm/packs-in-workspace',
      path: 'pnpm-workspace.yaml',
      message: 'packs/* must not be a workspace glob (RF-7)',
    });
  }
  if (settings.strictDepBuilds === false) {
    findings.push({
      rule: 'pnpm/strict-dep-builds',
      path: 'pnpm-workspace.yaml',
      message: 'strictDepBuilds must not be turned off (RF-3)',
    });
  }
}

export function checkWorkspaces(options: CheckWorkspacesOptions): Finding[] {
  const { root } = options;

  // 1. The static config gate. Nothing below may run while it has findings.
  const gate = checkConfigGate({
    root,
    ...(options.registersDir ? { registersDir: options.registersDir } : {}),
  });
  if (gate.findings.length > 0) return gate.findings;

  const findings: Finding[] = [];

  // 2. The gate's strict YAML reader and the full `yaml` parser must agree exactly, so no
  //    setting can be read one way by the gate and another way by pnpm or the checks below.
  const workspaceFile = join(root, 'pnpm-workspace.yaml');
  const settingsRaw = readYaml(workspaceFile);
  const settings = isRecord(settingsRaw) ? settingsRaw : {};
  if (!isRecord(settingsRaw)) {
    findings.push({
      rule: 'pnpm/settings',
      path: 'pnpm-workspace.yaml',
      message: 'not a YAML mapping',
    });
  }
  const workspaceText = readFileSync(workspaceFile, 'utf8');
  // Defence in depth (code review R3-1): the gate refuses a lone CR itself; asserting it again
  // here catches any future drift between the gate's reader and this check.
  if (LONE_CR.test(workspaceText)) {
    findings.push({
      rule: 'pnpm/lone-cr',
      path: 'pnpm-workspace.yaml',
      message:
        'contains a carriage return not followed by a line feed, which pnpm reads as a line break',
    });
    return findings;
  }
  const strict = parseMiniYaml(workspaceText);
  if (JSON.stringify(strict) !== JSON.stringify(settings)) {
    findings.push({
      rule: 'pnpm/yaml-differential',
      path: 'pnpm-workspace.yaml',
      message:
        "the gate's strict YAML reader and the yaml package read this file differently; simplify the YAML",
    });
  }

  // 3. Workspace coverage: every folder under the four roots is a workspace, and nothing else is.
  const dirs = listWorkspaceDirs(root);
  const inRoots = new Set(dirs);
  const resolved = new Set(resolveWorkspaceGlobs(root, settings.packages));
  for (const dir of [...resolved].sort()) {
    if (inRoots.has(dir)) continue;
    findings.push({
      rule: 'workspace/outside-roots',
      path: dir,
      message:
        'pnpm-workspace.yaml makes this a workspace, but workspaces may only be folders directly under apps/, packages/, services/ or tooling/ (packs/ never; RF-7)',
    });
  }

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

    if (!resolved.has(dir)) {
      findings.push({
        rule: 'workspace/not-in-globs',
        path: dir,
        message: 'has a package.json but no pnpm-workspace.yaml glob includes it',
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

  // 4. Specifiers in every manifest and in pnpm-workspace.yaml.
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
    checkSpecifiers(where, pkg, internalNames, allowlist, findings);
  }
  checkWorkspaceSettings(settings, findings);
  checkWorkspaceSpecifiers(settings, allowlist, findings);

  // 5. Python ban.
  checkPython((options.repoFiles ?? listRepoFiles(root)).map(toPosix), findings);

  return findings;
}
