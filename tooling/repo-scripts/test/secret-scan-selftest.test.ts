// TC-F-001-03 (dir), TC-F-001-37 (git, range, exit codes, canary) and TC-F-001-38 (artefact
// scan with the exact CI command; a missing artefact path fails) (AC-2; SEC-F001-05, -06, -20).
// Every synthetic credential is assembled at runtime (src/secret-scan-selftest.ts).
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HASH_FILE,
  SecretScanError,
  assertRange,
  currentPlatform,
  runGitleaks,
  sha256File,
  verifiedGitleaks,
} from '../src/secret-scan.ts';
import {
  ARTEFACT_SKIP_SHAPES,
  canary,
  frag,
  randomFrom,
  runSelftests,
  syntheticSet,
} from '../src/secret-scan-selftest.ts';
import { ARTEFACT_CONFIG_PATH, REPO_CONFIG_PATH, gitleaks, writeFile } from './gitleaks-bin.ts';
import { REAL_ROOT, cleanEnv } from './repo-copy.ts';
import { makeTempDir } from './temp.ts';

const reportDir = (): string => makeTempDir('ralysa-reports-');

function gitRepo(): { dir: string; commit: (file: string, content: string) => string } {
  const dir = makeTempDir('ralysa-git-');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  const git = (...args: string[]): string =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8', env }).stdout.trim();
  git('init', '--quiet', '--initial-branch=main');
  return {
    dir,
    commit: (file, content) => {
      writeFile(dir, file, content);
      git('add', '.');
      git('commit', '--quiet', '--no-verify', '-m', file);
      return git('rev-parse', 'HEAD');
    },
  };
}

describe('secret-scan self-tests (the CI selftest command)', () => {
  it('all four cases pass: dir, git, artefact and canary', () => {
    const results = runSelftests({
      root: REAL_ROOT,
      binary: gitleaks(),
      workDir: makeTempDir('ralysa-selftest-work-'),
      reportDir: reportDir(),
    });
    expect(results.map((r) => [r.name, r.ok, r.problems])).toEqual([
      ['dir', true, []],
      ['git', true, []],
      ['artefact', true, []],
      ['canary', true, []],
    ]);
  });
});

describe('TC-F-001-03: dir mode with --config .gitleaks.toml', () => {
  it('reports every synthetic credential at its file:line, and redacts the secrets', () => {
    const dir = makeTempDir('ralysa-dir-');
    const plants = syntheticSet();
    writeFile(dir, 'src/config.ts', `${plants.map((p) => p.line).join('\n')}\n`);
    const reports = reportDir();
    const result = runGitleaks({
      binary: gitleaks(),
      label: 'dir',
      mode: 'dir',
      target: dir,
      config: REPO_CONFIG_PATH,
      reportDir: reports,
    });
    expect(result.exitCode).toBe(1);
    for (const [index, plant] of plants.entries()) {
      expect(result.findings, plant.rule).toContainEqual({
        rule: plant.rule,
        file: 'src/config.ts',
        line: index + 1,
      });
    }
    // Redaction: no planted value appears in the JSON report.
    const report = readFileSync(result.reportPath, 'utf8');
    for (const plant of plants) {
      const value = /"([^"]+)"/.exec(plant.line)?.[1] ?? '';
      expect(report.includes(value), `${plant.rule} leaked into the report`).toBe(false);
    }
    expect(report).toContain('REDACTED');
  });
});

describe('TC-F-001-37: git mode, range assertion, exit codes', () => {
  it('finds the synthetic set in a commit range and ties each finding to the commit', () => {
    const repo = gitRepo();
    const first = repo.commit('README.md', 'clean\n');
    const plants = syntheticSet();
    const second = repo.commit('src/settings.ts', `${plants.map((p) => p.line).join('\n')}\n`);
    expect(assertRange(repo.dir, first, second)).toBe(1);
    const result = runGitleaks({
      binary: gitleaks(),
      label: 'git',
      mode: 'git',
      target: repo.dir,
      config: REPO_CONFIG_PATH,
      logOpts: `${first}..${second}`,
      reportDir: reportDir(),
    });
    expect(result.exitCode).toBe(1);
    expect(new Set(result.findings.map((f) => f.rule))).toEqual(new Set(plants.map((p) => p.rule)));
    expect(result.findings.every((f) => f.commit === second && f.file === 'src/settings.ts')).toBe(
      true,
    );
  });

  it('a clean range passes', () => {
    const repo = gitRepo();
    const first = repo.commit('README.md', 'clean\n');
    const second = repo.commit('src/a.ts', 'export const a = 1;\n');
    const result = runGitleaks({
      binary: gitleaks(),
      label: 'clean',
      mode: 'git',
      target: repo.dir,
      config: REPO_CONFIG_PATH,
      logOpts: `${first}..${second}`,
      reportDir: reportDir(),
    });
    expect(result).toMatchObject({ exitCode: 0, findings: [] });
  });

  it('the range helper fails on an empty range and on a commit that is not in the clone', () => {
    const repo = gitRepo();
    const head = repo.commit('README.md', 'x\n');
    expect(() => assertRange(repo.dir, head, head)).toThrow(
      /scan range is empty; is the base commit fetched\?/,
    );
    expect(() => assertRange(repo.dir, 'a'.repeat(40), head)).toThrow(/scan range is empty/);
    expect(() => assertRange(repo.dir, 'main', head)).toThrow(/must be commit SHAs/);
  });

  it.each([
    ['exit 2 (scanner error)', 'exit 2'],
    ['exit 126', 'exit 126'],
    ['a signal', 'kill -9 $$'],
    ['exit 1 with no report', 'exit 1'],
    [
      'exit 0 with findings',
      'for a in "$@"; do [ "$prev" = --report-path ] && printf \'[{"RuleID":"x","File":"f","StartLine":1}]\' > "$a"; prev=$a; done; exit 0',
    ],
  ])('the wrapper fails on %s', (_, body) => {
    const dir = makeTempDir('ralysa-fakebin-');
    const binary = writeFile(dir, 'gitleaks', `#!/bin/sh\n${body}\n`);
    chmodSync(binary, 0o755);
    expect(() =>
      runGitleaks({
        binary,
        label: 'fake',
        mode: 'dir',
        target: dir,
        config: REPO_CONFIG_PATH,
        reportDir: reportDir(),
      }),
    ).toThrow(SecretScanError);
  });

  it('fails when gitleaks exits 1 but its report is an empty array (code review finding 6)', () => {
    const dir = makeTempDir('ralysa-fakebin-');
    const binary = writeFile(
      dir,
      'gitleaks',
      '#!/bin/sh\nfor a in "$@"; do [ "$prev" = --report-path ] && printf \'[]\' > "$a"; prev=$a; done\nexit 1\n',
    );
    chmodSync(binary, 0o755);
    expect(() =>
      runGitleaks({
        binary,
        label: 'empty-report',
        mode: 'dir',
        target: dir,
        config: REPO_CONFIG_PATH,
        reportDir: reportDir(),
      }),
    ).toThrow(/gitleaks exited 1 for empty-report but its report is empty/);
  });

  it('refuses a target holding a .gitleaksignore (an allow-list outside the configs)', () => {
    const dir = makeTempDir('ralysa-ignore-');
    writeFile(dir, '.gitleaksignore', 'src/config.ts:github-pat:1\n');
    expect(() =>
      runGitleaks({
        binary: gitleaks(),
        label: 'ignore',
        mode: 'dir',
        target: dir,
        config: REPO_CONFIG_PATH,
        reportDir: reportDir(),
      }),
    ).toThrow(/\.gitleaksignore exists/);
  });

  it('the canary fires only when our config is loaded, not with the built-in default', () => {
    const dir = makeTempDir('ralysa-canary-');
    writeFile(dir, 'c.txt', `x = "${canary()}"\n`);
    const defaultOnly = writeFile(
      makeTempDir('ralysa-cfg-'),
      'default.toml',
      '[extend]\nuseDefault = true\n',
    );
    const withDefault = runGitleaks({
      binary: gitleaks(),
      label: 'default',
      mode: 'dir',
      target: dir,
      config: defaultOnly,
      reportDir: reportDir(),
    });
    expect(withDefault.findings.map((f) => f.rule)).not.toContain('ralysa-selftest-canary');
    for (const config of [REPO_CONFIG_PATH, ARTEFACT_CONFIG_PATH]) {
      const result = runGitleaks({
        binary: gitleaks(),
        label: 'ours',
        mode: 'dir',
        target: dir,
        config,
        reportDir: reportDir(),
      });
      expect(result.findings.map((f) => f.rule)).toContain('ralysa-selftest-canary');
    }
  });
});

describe('binary re-verification (SEC-F001-20)', () => {
  function fixtureRoot(binaryContent: string | undefined): string {
    const root = makeTempDir('ralysa-verify-');
    const real = readFileSync(join(REAL_ROOT, HASH_FILE), 'utf8');
    writeFile(root, HASH_FILE, real);
    if (binaryContent !== undefined)
      writeFile(root, '.tools/gitleaks/8.30.1/gitleaks', binaryContent);
    return root;
  }

  it('accepts the installed binary', () => {
    expect(verifiedGitleaks(REAL_ROOT)).toBe(gitleaks());
  });

  it('refuses a tampered binary', () => {
    const root = fixtureRoot('#!/bin/sh\nexit 0\n');
    expect(() => verifiedGitleaks(root)).toThrow(/does not match tool-hashes\.txt/);
  });

  it('refuses a missing binary, pointing at tools:install', () => {
    expect(() => verifiedGitleaks(fixtureRoot(undefined))).toThrow(/pnpm tools:install/);
  });

  it('refuses an unsupported platform', () => {
    expect(() => currentPlatform('win32', 'x64')).toThrow(/unsupported platform/);
    expect(currentPlatform('linux', 'x64')).toBe('linux_x64');
  });
});

describe('T05-1: the artefact config inherits no default allow-list', () => {
  const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  function plantShapes(): string {
    const dist = makeTempDir('ralysa-shapes-');
    for (const file of ARTEFACT_SKIP_SHAPES) {
      const pat = `${frag('gh', 'p_')}${randomFrom(ALNUM, 36)}`;
      writeFile(dist, file, `<!-- ${pat} -->\n<text>${canary()}</text>\n`);
    }
    return dist;
  }

  const scan = (dist: string, config: string) =>
    runGitleaks({
      binary: gitleaks(),
      label: 'shapes',
      mode: 'dir',
      target: dist,
      config,
      reportDir: reportDir(),
    });

  it.each([...ARTEFACT_SKIP_SHAPES])('%s is scanned with .gitleaks.artefacts.toml', (file) => {
    const result = scan(plantShapes(), ARTEFACT_CONFIG_PATH);
    const rules = result.findings
      .filter((f) => f.file === file)
      .map((f) => f.rule)
      .sort();
    expect(rules).toEqual(['github-pat', 'ralysa-selftest-canary']);
  });

  it('control: with [extend] useDefault (as in the repo config) the same shapes are skipped', () => {
    // Proves these really are the shapes the inherited global allow-list skips, so the test
    // above would catch a regression back to [extend].
    const shapes: readonly string[] = ARTEFACT_SKIP_SHAPES;
    const result = scan(plantShapes(), REPO_CONFIG_PATH);
    expect(result.findings.filter((f) => shapes.includes(f.file))).toEqual([]);
  });
});

describe('TC-F-001-38: artefact scan with the exact CI command', () => {
  function shippedRepo(withDist: boolean): string {
    const root = makeTempDir('ralysa-artefacts-');
    writeFile(root, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n');
    writeFile(root, 'package.json', '{"name":"ralysa","private":true}\n');
    for (const file of ['.gitleaks.toml', '.gitleaks.artefacts.toml', HASH_FILE]) {
      cpSync(join(REAL_ROOT, file), join(root, file));
    }
    // The real hash-pinned binary, re-verified by the wrapper as in CI.
    writeFile(root, '.tools/gitleaks/.keep', '');
    symlinkSync(join(REAL_ROOT, '.tools/gitleaks/8.30.1'), join(root, '.tools/gitleaks/8.30.1'));
    writeFile(
      root,
      'apps/web/package.json',
      JSON.stringify({
        name: '@ralysa/web',
        ralysa: { kind: 'app', shipped: true, ui: true, artefacts: ['dist'] },
      }),
    );
    writeFile(
      root,
      'apps/ui-lab/package.json',
      JSON.stringify({
        name: '@ralysa/ui-lab',
        ralysa: { kind: 'app', shipped: false, ui: true, artefacts: ['dist'] },
      }),
    );
    if (withDist) {
      const plants = syntheticSet().filter((p) =>
        ['anthropic-api-key', 'ralysa-selftest-canary'].includes(p.rule),
      );
      writeFile(
        root,
        'apps/web/dist/assets/index-abc123.js',
        `${plants.map((p) => p.line).join(';\n')}\n`,
      );
    }
    return root;
  }

  const cli = (root: string, ...args: string[]) =>
    spawnSync(
      process.execPath,
      [join(REAL_ROOT, 'tooling/repo-scripts/src/secret-scan-cli.ts'), ...args],
      {
        cwd: root,
        encoding: 'utf8',
        env: cleanEnv({ RUNNER_TEMP: makeTempDir('ralysa-runner-') }),
      },
    );

  it('a synthetic key under apps/web/dist/assets is found: no allow-list silences dist/', () => {
    gitleaks();
    const result = cli(shippedRepo(true), 'artefacts');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('✗ secret-scan artefact-apps/web/dist');
    expect(result.stderr).toContain('[secret/anthropic-api-key] assets/index-abc123.js:1');
    expect(result.stderr).toContain('[secret/ralysa-selftest-canary] assets/index-abc123.js:2');
    expect(result.stderr).toMatch(/Revoke and rotate/);
  });

  it('a missing artefact path fails, so 0 findings cannot come from scanning nothing', () => {
    gitleaks();
    const result = cli(shippedRepo(false), 'artefacts');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('shipped artefact path missing (build first): apps/web/dist');
  });

  it('a tampered binary makes every command fail closed', () => {
    const root = shippedRepo(true);
    const tampered = makeTempDir('ralysa-tampered-');
    const binary = writeFile(tampered, 'gitleaks', '#!/bin/sh\nexit 0\n');
    chmodSync(binary, 0o755);
    const link = join(root, '.tools/gitleaks/8.30.1');
    unlinkSync(link);
    symlinkSync(tampered, link);
    for (const command of ['artefacts', 'tree', 'selftest']) {
      const result = cli(root, command);
      expect(result.status, command).toBe(2);
      expect(result.stderr).toContain('does not match tool-hashes.txt');
    }
    expect(sha256File(binary)).not.toBe(sha256File(gitleaks()));
  });

  it('usage errors exit 2', () => {
    expect(cli(REAL_ROOT).status).toBe(2);
    expect(cli(REAL_ROOT, 'pr').status).toBe(2);
  });
});
