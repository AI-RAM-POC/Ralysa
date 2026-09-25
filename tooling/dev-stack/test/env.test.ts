// SEC-F002-29: the .env generator writes 0600, alphanumeric values only, stays inside its folder,
// never overwrites without --force and never writes through a symlink.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EnvFileError,
  VALUE_PATTERN,
  randomAlphanumeric,
  readEnvFile,
  writeEnvFile,
} from '../src/env.ts';
import { ENV_KEYS } from '../src/stack.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ralysa-devstack-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('randomAlphanumeric', () => {
  it('produces 48 characters from [A-Za-z0-9] and different values each time', () => {
    const values = new Set(Array.from({ length: 200 }, () => randomAlphanumeric()));
    expect(values.size).toBe(200);
    for (const value of values) expect(value).toMatch(/^[A-Za-z0-9]{48}$/);
  });

  it('uses the whole alphabet (no modulo gaps)', () => {
    const seen = new Set(randomAlphanumeric(20_000));
    expect(seen.size).toBe(62);
  });
});

describe('writeEnvFile (SEC-F002-29)', () => {
  it('writes every key with an alphanumeric value, mode 0600, and reads back', () => {
    const dir = tempDir();
    const result = writeEnvFile({ out: join(dir, '.env'), allowedDir: dir });
    expect(result.keys).toEqual([...ENV_KEYS]);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    const values = readEnvFile(result.path);
    for (const key of ENV_KEYS) expect(values[key]).toMatch(VALUE_PATTERN);
    expect(values.POSTGRES_PASSWORD).not.toBe(values.BAO_DEV_ROOT_TOKEN_ID);
  });

  it('resolves a relative --out against the working directory', () => {
    const dir = tempDir();
    const result = writeEnvFile({ out: '.env.ci', cwd: dir, allowedDir: dir });
    expect(result.path).toBe(join(dir, '.env.ci'));
  });

  it.each([
    ['a sibling folder', (dir: string) => join(dir, '..', 'elsewhere', '.env')],
    ['the parent folder', (dir: string) => join(dir, '..', '.env')],
    ['an absolute system path', () => '/etc/.env'],
  ])('refuses a path in %s', (_label, target) => {
    const dir = join(tempDir(), 'allowed');
    mkdirSync(dir);
    mkdirSync(join(dir, '..', 'elsewhere'));
    expect(() => writeEnvFile({ out: target(dir), allowedDir: dir })).toThrow(EnvFileError);
  });

  it('refuses a folder that is a symlink out of the allowed folder', () => {
    const dir = tempDir();
    const outside = tempDir();
    symlinkSync(outside, join(dir, 'link'));
    expect(() => writeEnvFile({ out: join(dir, 'link', '.env'), allowedDir: dir })).toThrow(
      /only writes inside/,
    );
  });

  it('refuses a file name that is not git-ignored as .env*', () => {
    const dir = tempDir();
    expect(() => writeEnvFile({ out: join(dir, 'secrets.txt'), allowedDir: dir })).toThrow(
      /must start with \.env/,
    );
  });

  it('never overwrites without --force, and replaces with it', () => {
    const dir = tempDir();
    const out = join(dir, '.env');
    const first = readEnvFile(writeEnvFile({ out, allowedDir: dir }).path);
    expect(() => writeEnvFile({ out, allowedDir: dir })).toThrow(/pass --force/);
    expect(readEnvFile(out)).toEqual(first);
    writeEnvFile({ out, allowedDir: dir, force: true });
    expect(readEnvFile(out).POSTGRES_PASSWORD).not.toBe(first.POSTGRES_PASSWORD);
  });

  it('does not write through a symlink planted at the target', () => {
    const dir = tempDir();
    const victim = join(tempDir(), 'victim.txt');
    writeFileSync(victim, 'untouched\n');
    const out = join(dir, '.env');
    symlinkSync(victim, out);
    expect(() => writeEnvFile({ out, allowedDir: dir })).toThrow(/pass --force/);
    writeEnvFile({ out, allowedDir: dir, force: true });
    expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
    expect(lstatSync(out).isSymbolicLink()).toBe(false);
  });

  it('prints one ::add-mask:: line per value with --github-mask, and nothing without', () => {
    const dir = tempDir();
    const lines: string[] = [];
    const result = writeEnvFile({
      out: join(dir, '.env'),
      allowedDir: dir,
      mask: (line) => lines.push(line),
    });
    const values = readEnvFile(result.path);
    expect(lines).toEqual(ENV_KEYS.map((key) => `::add-mask::${String(values[key])}`));
  });

  it('refuses a fixed value that is not long alphanumeric', () => {
    const dir = tempDir();
    expect(() =>
      writeEnvFile({
        out: join(dir, '.env'),
        allowedDir: dir,
        values: { POSTGRES_PASSWORD: 'p@ss:word/with%chars' },
      }),
    ).toThrow(/must match/);
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });
});

describe('cli env', () => {
  const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');

  it('exits 2 and writes nothing for a path outside deploy/docker/dev', () => {
    const dir = tempDir();
    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [cli, 'env', '--out', join(dir, '.env')], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const e = error as { status: number; stderr: Buffer };
      status = e.status;
      stderr = e.stderr.toString();
    }
    expect(status).toBe(2);
    expect(stderr).toMatch(/only writes inside/);
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  it('prints usage and exits 2 for an unknown command', () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [cli, 'nope'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      status = (error as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});
