// Dependency-free helpers (Node built-ins only). The pre-install gate imports only this module,
// lib/mini-yaml.ts and config-gate.ts, so it runs before `pnpm install` with no node_modules and
// never starts a subprocess.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Top-level folders whose immediate subfolders must each be a workspace (F-001 design §2.1). */
export const WORKSPACE_ROOTS = ['apps', 'packages', 'services', 'tooling'] as const;

export interface Finding {
  rule: string;
  path: string;
  message: string;
}

/** The repository root: the nearest ancestor of `start` that has pnpm-workspace.yaml. */
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

/** Every file under `root` (posix, relative), skipping node_modules and .git. No subprocess. */
export function walkFiles(root: string, dir = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, full));
    else files.push(toPosix(relative(root, full)));
  }
  return files.sort();
}

export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `  ✗ [${f.rule}] ${f.path}: ${f.message}`).join('\n');
}
