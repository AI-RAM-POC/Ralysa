// placeholder-guard (F-001 design §2.1). An empty spec folder is a placeholder package whose
// lint, typecheck, test and build scripts all run this guard. It passes while the folder holds
// only README.md and package.json, and fails as soon as any other file appears, so no package can
// quietly gain code without real lint and test wiring.
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  type Finding,
  findRepoRoot,
  isRecord,
  listRepoFiles,
  readJson,
  toPosix,
} from './lib/repo.ts';

export const PLACEHOLDER_FILES = ['README.md', 'package.json'] as const;

export interface PlaceholderGuardOptions {
  /** The placeholder package directory (absolute). */
  dir: string;
  root?: string;
  /** Repo files (posix, relative to root); defaults to git's view of the tree. */
  repoFiles?: string[];
}

export function placeholderGuard({
  dir,
  root = findRepoRoot(dir),
  repoFiles,
}: PlaceholderGuardOptions): Finding[] {
  const rel = toPosix(relative(root, dir));
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) {
    return [{ rule: 'placeholder/not-a-package', path: rel, message: 'no package.json' }];
  }
  const pkg = readJson(manifest);
  if (!isRecord(pkg) || !isRecord(pkg.ralysa) || pkg.ralysa.kind !== 'placeholder') {
    return [
      {
        rule: 'placeholder/wrong-kind',
        path: `${rel}/package.json`,
        message: 'placeholder-guard only runs in a package with ralysa.kind = "placeholder"',
      },
    ];
  }
  const prefix = `${rel}/`;
  const extra = (repoFiles ?? listRepoFiles(root))
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length))
    .filter((file) => !(PLACEHOLDER_FILES as readonly string[]).includes(file));
  return extra.map((file) => ({
    rule: 'placeholder/has-code',
    path: `${rel}/${file}`,
    message: `this is a placeholder package; convert it with "pnpm scaffold ${rel} --kind <library|library-isomorphic|service|app|cli>" before adding files`,
  }));
}
