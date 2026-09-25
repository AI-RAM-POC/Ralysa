// Helpers for the post-install repo checks: they may use installed packages (typescript, yaml)
// and git, but never pnpm. The dependency-free helpers live in core.ts and are re-exported here.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { walkFiles } from './core.ts';

export {
  type Finding,
  findRepoRoot,
  formatFindings,
  isRecord,
  listWorkspaceDirs,
  readJson,
  toPosix,
  walkFiles,
  WORKSPACE_ROOTS,
} from './core.ts';

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

/**
 * Every file git would consider part of the tree that exists on disk: tracked plus
 * untracked-but-not-ignored.
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
    // --cached still lists a file deleted in the working tree until the deletion is staged.
    return [...new Set(out.split('\0').filter((file) => file !== ''))]
      .filter((file) => existsSync(join(root, file)))
      .sort();
  } catch {
    return walkFiles(root);
  }
}
