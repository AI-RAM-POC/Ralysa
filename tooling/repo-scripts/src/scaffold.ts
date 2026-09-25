// scaffold (F-001 design §2.1, RC-6): `pnpm scaffold <path> --kind <kind>` turns a placeholder
// folder (or a new folder) into a real package from tooling/repo-scripts/templates/<kind>/.
// Every template passes check-workspaces, lint, typecheck, test and build on creation
// (TC-F-001-46). Template files end in `.tmpl` so no tool in this repo lints, type-checks or
// runs them in place.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord, listRepoFiles, readJson, readJsonc, toPosix } from './lib/repo.ts';
import { PLACEHOLDER_FILES } from './placeholder-guard.ts';

export const SCAFFOLD_KINDS = ['library', 'library-isomorphic', 'service', 'app', 'cli'] as const;
export type ScaffoldKind = (typeof SCAFFOLD_KINDS)[number];

/** Which top-level folder each kind belongs in (spec §10.4 layout). */
const KIND_ROOTS: Record<ScaffoldKind, string> = {
  library: 'packages',
  'library-isomorphic': 'packages',
  service: 'services',
  app: 'apps',
  cli: 'apps',
};

export const DEFAULT_TEMPLATES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'templates',
);

export interface ScaffoldOptions {
  root: string;
  /** Target folder relative to the repo root, for example "services/agent-host". */
  target: string;
  kind: ScaffoldKind;
  templatesDir?: string;
  /** Repo files used to prove an existing folder is still a bare placeholder. */
  repoFiles?: string[];
}

export interface ScaffoldResult {
  packageName: string;
  written: string[];
}

export class ScaffoldError extends Error {}

function templateFiles(dir: string, base = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...templateFiles(full, base));
    else if (entry.name.endsWith('.tmpl')) files.push(toPosix(relative(base, full)));
  }
  return files.sort();
}

function render(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match);
}

function assertConvertible(root: string, target: string, repoFiles: string[] | undefined): void {
  const dir = join(root, target);
  if (!existsSync(dir)) return;
  const manifest = join(dir, 'package.json');
  if (existsSync(manifest)) {
    const pkg = readJson(manifest);
    if (!isRecord(pkg) || !isRecord(pkg.ralysa) || pkg.ralysa.kind !== 'placeholder') {
      throw new ScaffoldError(
        `${target} is already a real package; scaffold only converts placeholders`,
      );
    }
  }
  const prefix = `${target}/`;
  const extra = (repoFiles ?? listRepoFiles(root))
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length))
    .filter((file) => !(PLACEHOLDER_FILES as readonly string[]).includes(file));
  if (extra.length > 0) {
    throw new ScaffoldError(
      `${target} holds files other than README.md and package.json: ${extra.join(', ')}`,
    );
  }
}

/** Adds `target` to the root solution tsconfig.json, keeping the references sorted. */
export function addRootReference(root: string, target: string): void {
  const file = join(root, 'tsconfig.json');
  const config = existsSync(file) ? readJsonc(file) : {};
  const refs = new Set<string>();
  if (isRecord(config) && Array.isArray(config.references)) {
    for (const ref of config.references as unknown[]) {
      if (isRecord(ref) && typeof ref.path === 'string') refs.add(ref.path);
    }
  }
  refs.add(target);
  writeFileSync(file, formatRootTsconfig([...refs]));
}

export function formatRootTsconfig(references: string[]): string {
  const lines = [...references].sort().map((path) => `    { "path": "${path}" }`);
  return `{\n  "files": [],\n  "references": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

export function scaffold(options: ScaffoldOptions): ScaffoldResult {
  const { root, kind } = options;
  const target = toPosix(options.target).replace(/\/+$/, '');
  if (!(SCAFFOLD_KINDS as readonly string[]).includes(kind)) {
    throw new ScaffoldError(`unknown kind "${kind}"; use one of ${SCAFFOLD_KINDS.join(', ')}`);
  }
  const match = /^(apps|packages|services)\/([a-z][a-z0-9-]*)$/.exec(target);
  if (match === null) {
    throw new ScaffoldError(
      `target must be apps/<name>, packages/<name> or services/<name> in lowercase kebab-case`,
    );
  }
  const [, top, name] = match as unknown as [string, string, string];
  if (KIND_ROOTS[kind] !== top) {
    throw new ScaffoldError(`a ${kind} belongs under ${KIND_ROOTS[kind]}/, not ${top}/`);
  }
  assertConvertible(root, target, options.repoFiles);

  const templateDir = join(options.templatesDir ?? DEFAULT_TEMPLATES_DIR, kind);
  const packageName = `@ralysa/${name}`;
  const vars = { name, package: packageName, dir: target, kind };
  const dir = join(root, target);
  const written: string[] = [];

  for (const file of templateFiles(templateDir)) {
    const out = file.slice(0, -'.tmpl'.length);
    const destination = join(dir, out);
    // A placeholder's README describes the package's purpose; keep it.
    if (out === 'README.md' && existsSync(destination)) continue;
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, render(readFileSync(join(templateDir, file), 'utf8'), vars));
    written.push(`${target}/${out}`);
  }

  addRootReference(root, target);
  return { packageName, written };
}
