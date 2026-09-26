// TC-F-001-40 (AC-2; SEC-F001-07, -20): the repo-managed git pre-commit hook blocks a commit that
// stages a synthetic credential, in a temp repo with core.hooksPath set, and fails closed when
// gitleaks is missing, differs from tool-hashes.txt, or a .gitleaksignore is present. The Claude
// Code guard's side (fixtures 36 to 39) is in .claude/hooks/test/.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULE_ENTROPY, detectable, frag } from '../src/secret-scan-selftest.ts';
import { gitleaks } from './gitleaks-bin.ts';
import { REAL_ROOT, cleanEnv } from './repo-copy.ts';
import { makeTempDir } from './temp.ts';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HOOK_FILES = [
  '.githooks/pre-commit',
  'tooling/repo-scripts/bin/gitleaks-staged.sh',
  'tooling/repo-scripts/bin/install-tool.sh',
  'tooling/repo-scripts/bin/tool-hashes.txt',
  '.gitleaks.toml',
];

/** A GitHub-PAT-shaped value that was never issued, assembled at run time. */
function syntheticToken(): string {
  return detectable(frag('gh', 'p_'), ALNUM, 36, RULE_ENTROPY['github-pat']);
}

interface Repo {
  dir: string;
  git: (...args: string[]) => { status: number; stdout: string; stderr: string };
  write: (path: string, content: string) => void;
  binaryPath: string;
}

/**
 * A temp repo holding copies of the hook, its scripts and the repo config, with the real,
 * hash-verified gitleaks linked into .tools/ and core.hooksPath set to .githooks.
 */
function hookedRepo(): Repo {
  const dir = makeTempDir('ralysa-precommit-');
  for (const file of HOOK_FILES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(REAL_ROOT, file), join(dir, file));
  }
  const real = gitleaks();
  const binaryPath = join(dir, relative(REAL_ROOT, real));
  mkdirSync(dirname(binaryPath), { recursive: true });
  symlinkSync(real, binaryPath);
  const env = cleanEnv({
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  });
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
  };
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, '.gitignore'), '.tools/\n');
  git('add', '-A');
  expect(git('commit', '-q', '-m', 'initial').status).toBe(0);
  git('config', 'core.hooksPath', '.githooks');
  return { dir, git, write, binaryPath };
}

const head = (repo: Repo) => repo.git('rev-parse', 'HEAD').stdout.trim();

describe('.githooks/pre-commit (TC-F-001-40)', () => {
  it('blocks a commit that stages a synthetic credential, and prints it redacted', () => {
    const repo = hookedRepo();
    const before = head(repo);
    const token = syntheticToken();
    repo.write('src/config.ts', `export const token = '${token}';\n`);
    repo.git('add', 'src/config.ts');
    const result = repo.git('commit', '-m', 'F-001: add config');
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('secrets found in the staged changes');
    expect(output).toContain('github-pat');
    expect(output).not.toContain(token);
    expect(head(repo)).toBe(before);
  });

  it('blocks `git commit -a` with a credential in a tracked file (the hook runs after -a stages)', () => {
    const repo = hookedRepo();
    repo.write('src/config.ts', 'export const answer = 42;\n');
    repo.git('add', 'src/config.ts');
    expect(repo.git('commit', '-q', '-m', 'tracked').status).toBe(0);
    const before = head(repo);
    repo.write('src/config.ts', `export const token = '${syntheticToken()}';\n`);
    expect(repo.git('commit', '-a', '-m', 'F-001: edit').status).not.toBe(0);
    expect(head(repo)).toBe(before);
  });

  it('lets a clean commit through', () => {
    const repo = hookedRepo();
    repo.write('src/app.ts', 'export const answer = 42;\n');
    repo.git('add', 'src/app.ts');
    const result = repo.git('commit', '-m', 'F-001: clean');
    expect(result.status, result.stderr).toBe(0);
  });

  it('fails closed when gitleaks is not installed', () => {
    const repo = hookedRepo();
    rmSync(join(repo.dir, '.tools'), { recursive: true, force: true });
    repo.write('src/app.ts', 'export const answer = 42;\n');
    repo.git('add', 'src/app.ts');
    const result = repo.git('commit', '-m', 'F-001: clean');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('pnpm tools:install');
  });

  it("fails closed when the binary doesn't match tool-hashes.txt", () => {
    const repo = hookedRepo();
    rmSync(repo.binaryPath);
    writeFileSync(repo.binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    repo.write('src/config.ts', `export const token = '${syntheticToken()}';\n`);
    repo.git('add', 'src/config.ts');
    const result = repo.git('commit', '-m', 'F-001: add config');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("doesn't match tool-hashes.txt");
  });

  it('refuses to run with a .gitleaksignore in the repository', () => {
    const repo = hookedRepo();
    repo.write('.gitleaksignore', '');
    repo.write('src/app.ts', 'export const answer = 42;\n');
    repo.git('add', 'src/app.ts');
    const result = repo.git('commit', '-m', 'F-001: clean');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('.gitleaksignore exists');
  });
});
