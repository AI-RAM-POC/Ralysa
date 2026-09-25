// Builds a package's node_modules from exactly the dependencies its package.json declares, as
// symlinks to the copies already installed in the real repo, plus a .bin/ of node shims for their
// executables. A template that forgets a dependency therefore fails its gates here the same way
// it would after a real `pnpm install` (code review m3).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isRecord, listWorkspaceDirs, readJson } from '../src/lib/repo.ts';
import { REAL_ROOT } from './repo-copy.ts';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'] as const;

function workspaceByName(): Map<string, string> {
  const byName = new Map<string, string>();
  for (const dir of listWorkspaceDirs(REAL_ROOT)) {
    const manifest = join(REAL_ROOT, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = readJson(manifest);
    if (isRecord(pkg) && typeof pkg.name === 'string') byName.set(pkg.name, join(REAL_ROOT, dir));
  }
  return byName;
}

/** Where the real install has `name`: a workspace, a workspace's direct dependency, or pnpm's hidden hoist. */
function resolveInstalled(name: string, workspaces: Map<string, string>): string {
  const workspace = workspaces.get(name);
  if (workspace !== undefined) return workspace;
  const candidates = [
    ...[...workspaces.values()].map((dir) => join(dir, 'node_modules', name)),
    join(REAL_ROOT, 'node_modules', name),
    join(REAL_ROOT, 'node_modules', '.pnpm', 'node_modules', name),
  ];
  const found = candidates.find((path) => existsSync(join(path, 'package.json')));
  if (found === undefined) throw new Error(`${name} is not installed anywhere in ${REAL_ROOT}`);
  return realpathSync(found);
}

function binsOf(packageDir: string, name: string): [string, string][] {
  const pkg = readJson(join(packageDir, 'package.json'));
  if (!isRecord(pkg)) return [];
  const { bin } = pkg;
  if (typeof bin === 'string') return [[name.replace(/^@[^/]+\//, ''), bin]];
  if (isRecord(bin)) {
    return Object.entries(bin).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
  }
  return [];
}

/** Returns the names it linked. */
export function linkDeclaredDependencies(packageDir: string): string[] {
  const pkg = readJson(join(packageDir, 'package.json'));
  if (!isRecord(pkg)) throw new Error(`${packageDir}/package.json is not an object`);
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const group = pkg[field];
    if (isRecord(group)) for (const name of Object.keys(group)) names.add(name);
  }
  const workspaces = workspaceByName();
  const modules = join(packageDir, 'node_modules');
  const bin = join(modules, '.bin');
  mkdirSync(bin, { recursive: true });
  for (const name of [...names].sort()) {
    const source = resolveInstalled(name, workspaces);
    const link = join(modules, name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(source, link, 'dir');
    for (const [command, file] of binsOf(source, name)) {
      const shim = join(bin, command);
      writeFileSync(shim, `#!/bin/sh\nexec node "${join(source, file)}" "$@"\n`);
      chmodSync(shim, 0o755);
    }
  }
  return [...names];
}
