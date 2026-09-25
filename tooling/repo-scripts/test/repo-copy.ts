// Copies the working tree (tracked + untracked-not-ignored files, as git sees them) into a temp
// folder, so integration tests can change configs or scaffold packages without touching the repo.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findRepoRoot, listRepoFiles } from '../src/lib/repo.ts';
import { makeTempDir } from './temp.ts';

export const REAL_ROOT = findRepoRoot();

export function copyRepo(prefix = 'ralysa-copy-'): string {
  const target = makeTempDir(prefix);
  for (const file of listRepoFiles(REAL_ROOT)) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    cpSync(join(REAL_ROOT, file), join(target, file), { verbatimSymlinks: true });
  }
  return target;
}

/** Environment for child processes: no inherited npm/pnpm/Turbo run state, telemetry off. */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|PNPM_|TURBO_|VITEST|NODE_OPTIONS$|INIT_CWD$)/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', ...extra };
}
