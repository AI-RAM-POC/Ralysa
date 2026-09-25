// Every temp folder a test creates goes through makeTempDir, and test/setup.ts removes them all
// after each test file. rmSync doesn't follow symlinks, so the node_modules links that the
// scaffold test creates are removed without touching their targets.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
