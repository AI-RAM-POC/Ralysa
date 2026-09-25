// The secret-scan tests run the real, hash-pinned gitleaks: detection is the thing under test,
// so a fake would prove nothing. They fail (never skip) when it isn't installed, so CI can't pass
// them silently; the `quality` job installs it before the Turbo run.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { verifiedGitleaks } from '../src/secret-scan.ts';
import { REAL_ROOT } from './repo-copy.ts';

export function gitleaks(): string {
  try {
    return verifiedGitleaks(REAL_ROOT);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nThe secret-scan tests run the real gitleaks: run "pnpm tools:install" once.`,
      { cause: error },
    );
  }
}

export const REPO_CONFIG_PATH = join(REAL_ROOT, '.gitleaks.toml');
export const ARTEFACT_CONFIG_PATH = join(REAL_ROOT, '.gitleaks.artefacts.toml');

export function writeFile(root: string, path: string, content: string): string {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}
