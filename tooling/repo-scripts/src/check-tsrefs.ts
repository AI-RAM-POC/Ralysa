// check-tsrefs (F-001 design §2): the root tsconfig.json is a solution file that references every
// TypeScript workspace, and each workspace references the TypeScript libraries it depends on, so
// `tsc -b` and editors see the same project graph as pnpm.
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { type Finding, isRecord, listWorkspaceDirs, readJson, readJsonc } from './lib/repo.ts';

export interface CheckTsrefsOptions {
  root: string;
}

function referencePaths(config: unknown, fromDir: string): string[] {
  if (!isRecord(config) || !Array.isArray(config.references)) return [];
  return config.references
    .map((ref: unknown) => (isRecord(ref) && typeof ref.path === 'string' ? ref.path : undefined))
    .filter((path): path is string => path !== undefined)
    .map((path) => posix.normalize(posix.join(fromDir, path)).replace(/\/tsconfig\.json$/, ''));
}

export function checkTsrefs({ root }: CheckTsrefsOptions): Finding[] {
  const findings: Finding[] = [];
  const tsWorkspaces = listWorkspaceDirs(root).filter((dir) =>
    existsSync(join(root, dir, 'tsconfig.json')),
  );

  const rootConfigFile = join(root, 'tsconfig.json');
  if (!existsSync(rootConfigFile)) {
    return [
      {
        rule: 'tsrefs/root-missing',
        path: 'tsconfig.json',
        message: 'the root solution tsconfig.json is missing',
      },
    ];
  }
  const rootConfig = readJsonc(rootConfigFile);
  const rootRefs = new Set(referencePaths(rootConfig, '.'));

  for (const dir of tsWorkspaces) {
    if (!rootRefs.has(dir)) {
      findings.push({
        rule: 'tsrefs/root-missing-reference',
        path: 'tsconfig.json',
        message: `add { "path": "${dir}" } to references`,
      });
    }
  }
  for (const ref of rootRefs) {
    if (!tsWorkspaces.includes(ref)) {
      findings.push({
        rule: 'tsrefs/root-stale-reference',
        path: 'tsconfig.json',
        message: `references "${ref}", which is not a workspace with a tsconfig.json`,
      });
    }
  }
  if (isRecord(rootConfig) && Array.isArray(rootConfig.files) && rootConfig.files.length > 0) {
    findings.push({
      rule: 'tsrefs/root-files',
      path: 'tsconfig.json',
      message: 'the solution file must have "files": []',
    });
  }

  // Name → dir for TypeScript libraries (the only workspaces other workspaces compile against).
  const libraries = new Map<string, string>();
  for (const dir of tsWorkspaces) {
    const pkg = readJson(join(root, dir, 'package.json'));
    if (
      isRecord(pkg) &&
      typeof pkg.name === 'string' &&
      isRecord(pkg.ralysa) &&
      pkg.ralysa.kind === 'library'
    ) {
      libraries.set(pkg.name, dir);
    }
  }

  for (const dir of tsWorkspaces) {
    const pkg = readJson(join(root, dir, 'package.json'));
    if (!isRecord(pkg)) continue;
    const refs = new Set(referencePaths(readJsonc(join(root, dir, 'tsconfig.json')), dir));
    const deps = new Set(
      ['dependencies', 'devDependencies'].flatMap((field) => {
        const group = pkg[field];
        return isRecord(group) ? Object.keys(group) : [];
      }),
    );
    for (const name of deps) {
      const libDir = libraries.get(name);
      if (libDir !== undefined && !refs.has(libDir)) {
        findings.push({
          rule: 'tsrefs/missing-reference',
          path: `${dir}/tsconfig.json`,
          message: `depends on ${name} but does not reference "${posix.relative(dir, libDir)}"`,
        });
      }
    }
    for (const ref of refs) {
      if (!existsSync(join(root, ref, 'tsconfig.json'))) {
        findings.push({
          rule: 'tsrefs/stale-reference',
          path: `${dir}/tsconfig.json`,
          message: `references "${ref}", which has no tsconfig.json`,
        });
      }
    }
  }
  return findings;
}
