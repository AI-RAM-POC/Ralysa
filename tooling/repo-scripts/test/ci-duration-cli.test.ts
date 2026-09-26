// `node src/cli.ts ci-duration` through the real entry point (review R63-2): the exit codes the
// CLI maps (0 within budget, 1 over budget, 2 on a usage or gh error). A fake `gh` first on PATH
// stands in for GitHub, so there is no network and no login.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanEnv, REAL_ROOT } from './repo-copy.ts';
import { makeTempDir } from './temp.ts';

const CLI = join(REAL_ROOT, 'tooling', 'repo-scripts', 'src', 'cli.ts');
const FIXTURE = join(import.meta.dirname, 'fixtures', 'ci-duration-runs.json');

/** A fake gh that records its argv, then prints `stdout` (a file) or fails with `exitCode`. */
function fakeGh(behaviour: { stdout: string } | { exitCode: number }) {
  const dir = makeTempDir('ralysa-fake-gh-');
  const argsFile = join(dir, 'args');
  mkdirSync(join(dir, 'bin'));
  const body =
    'stdout' in behaviour
      ? `cat '${behaviour.stdout}'\n`
      : `echo 'gh: simulated failure' >&2\nexit ${String(behaviour.exitCode)}\n`;
  writeFileSync(join(dir, 'bin', 'gh'), `#!/bin/sh\necho "$*" > '${argsFile}'\n${body}`);
  chmodSync(join(dir, 'bin', 'gh'), 0o755);
  const env = cleanEnv({ PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` });
  return { env, argsFile, dir };
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [CLI, 'ci-duration', ...args], {
    cwd: REAL_ROOT,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('ralysa-repo ci-duration exit codes (fake gh, no network)', () => {
  it('0 within budget, with the report on stdout', () => {
    const gh = fakeGh({ stdout: FIXTURE });
    const result = run([], gh.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('p95 9m 40s  (budget 15m 00s: ok)');
    expect(result.stdout).toContain('excluded: cancelled 3');
    expect(readFileSync(gh.argsFile, 'utf8')).toContain(
      'run list --workflow ci.yml --event pull_request --status completed',
    );
  });

  it('1 over budget', () => {
    const gh = fakeGh({ stdout: FIXTURE });
    const slow = join(gh.dir, 'slow.json');
    writeFileSync(
      slow,
      JSON.stringify([
        {
          databaseId: 1,
          conclusion: 'timed_out',
          headBranch: 'feat/F-000-slow',
          startedAt: '2026-09-26T10:00:00Z',
          updatedAt: '2026-09-26T10:20:00Z',
        },
      ]),
    );
    const result = run([], fakeGh({ stdout: slow }).env);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('OVER BUDGET');
  });

  it('2 on a usage error, before gh is started', () => {
    const gh = fakeGh({ stdout: FIXTURE });
    const result = run(['--limit', '0'], gh.env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ci-duration: --limit must be an integer from 1 to 100');
    expect(existsSync(gh.argsFile)).toBe(false);
  });

  it('2 when gh fails (not a pass, not an over-budget 1)', () => {
    const result = run([], fakeGh({ exitCode: 4 }).env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ci-duration:');
    expect(result.stdout).toBe('');
  });

  it('2 when gh prints something that is not a run list', () => {
    const gh = fakeGh({ stdout: FIXTURE });
    const bad = join(gh.dir, 'bad.json');
    writeFileSync(bad, '{"message":"not a list"}');
    const result = run([], fakeGh({ stdout: bad }).env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ci-duration:');
  });
});
