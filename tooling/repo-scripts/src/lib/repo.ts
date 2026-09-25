// Small filesystem, git and pnpm helpers shared by the repo checks. Everything that touches the
// outside world is injectable so the checks can run against fixture repos in unit tests.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

/** Top-level folders whose immediate subfolders must each be a workspace (F-001 design §2.1). */
export const WORKSPACE_ROOTS = ['apps', 'packages', 'services', 'tooling'] as const;

export interface Finding {
  rule: string;
  path: string;
  message: string;
}

/** The repository root: the nearest ancestor of this file that has pnpm-workspace.yaml. */
export function findRepoRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no pnpm-workspace.yaml above ${start}`);
    dir = parent;
  }
  return dir;
}

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

/** Reads a tsconfig-style file (JSON with comments and trailing commas). */
export function readJsonc(file: string): unknown {
  const result: { config?: unknown; error?: ts.Diagnostic } = ts.parseConfigFileTextToJson(
    file,
    readFileSync(file, 'utf8'),
  );
  if (result.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(result.error.messageText, '\n'));
  }
  return result.config;
}

export function readYaml(file: string): unknown {
  return parseYaml(readFileSync(file, 'utf8')) as unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Relative paths (posix) of every directory directly under apps/, packages/, services/, tooling/. */
export function listWorkspaceDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const top of WORKSPACE_ROOTS) {
    const topDir = join(root, top);
    if (!existsSync(topDir)) continue;
    for (const entry of readdirSync(topDir)) {
      if (entry.startsWith('.')) continue;
      if (statSync(join(topDir, entry)).isDirectory()) dirs.push(`${top}/${entry}`);
    }
  }
  return dirs.sort();
}

/** Workspace directories as pnpm sees them (`pnpm ls -r --depth -1 --json`), excluding the root. */
export function listPnpmWorkspaces(root: string): string[] {
  const out = execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const projects = JSON.parse(out) as { path: string }[];
  return projects
    .map((project) => toPosix(relative(root, project.path)))
    .filter((path) => path !== '')
    .sort();
}

/**
 * Every file git would consider part of the tree: tracked plus untracked-but-not-ignored.
 * Falls back to a filesystem walk (skipping node_modules and dot-folders) outside a git checkout.
 */
export function listRepoFiles(root: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return [...new Set(out.split('\0').filter((file) => file !== ''))].sort();
  } catch {
    return walk(root, root);
  }
}

function walk(root: string, dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(root, full));
    else files.push(toPosix(relative(root, full)));
  }
  return files.sort();
}

export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `  ✗ [${f.rule}] ${f.path}: ${f.message}`).join('\n');
}
