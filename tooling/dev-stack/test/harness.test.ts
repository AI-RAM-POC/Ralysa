// The harness skips cleanly without a dev stack, and refuses to skip in CI.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { devStackOrSkip, devStackRequired, probeDevStack } from '../src/harness/index.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ralysa-harness-'));
  dirs.push(dir);
  return dir;
}

describe('dev-stack harness', () => {
  it('reports a missing .env without touching the network', async () => {
    const probe = await probeDevStack(join(tempDir(), '.env'));
    expect(probe).toEqual({ ok: false, reason: expect.stringContaining('does not exist') });
  });

  it('reports an incomplete .env', async () => {
    const env = join(tempDir(), '.env');
    writeFileSync(env, 'POSTGRES_PASSWORD=abc\n');
    const probe = await probeDevStack(env);
    expect(probe).toEqual({ ok: false, reason: expect.stringContaining('incomplete') });
  });

  it.each([
    [{ CI: '1' }, true],
    [{ CI: 'true' }, true],
    [{ RALYSA_REQUIRE_DEV_STACK: '1' }, true],
    [{}, false],
    [{ CI: '0' }, false],
  ])('devStackRequired(%o) is %s', (env, expected) => {
    expect(devStackRequired(env)).toBe(expected);
  });

  it('skips with one message locally, and throws when required', async () => {
    const envFile = join(tempDir(), '.env');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(devStackOrSkip({ envFile, env: {} })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('integration tests skipped'));
    await expect(devStackOrSkip({ envFile, env: { CI: '1' } })).rejects.toThrow(
      /dev stack required/,
    );
  });
});
