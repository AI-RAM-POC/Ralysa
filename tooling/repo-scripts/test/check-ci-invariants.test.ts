// TC-F-001-44, check-ci-invariants part (SEC-F001-06, -20, -21).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { checkCiInvariants, checkCiInvariantsFiles } from '../src/check-ci-invariants.ts';
import { REAL_ROOT } from './repo-copy.ts';

const realPkg = JSON.parse(readFileSync(join(REAL_ROOT, 'package.json'), 'utf8')) as Record<
  string,
  unknown
>;
const realCi = readFileSync(join(REAL_ROOT, '.github/workflows/ci.yml'), 'utf8');

function rules(
  options: { pkg?: unknown; ci?: string; scripts?: Record<string, string> } = {},
): string[] {
  return checkCiInvariants({
    packageJson: options.pkg ?? realPkg,
    workflows: new Map([['.github/workflows/ci.yml', parse(options.ci ?? realCi) as unknown]]),
    scripts: new Map(Object.entries(options.scripts ?? {})),
  }).map((f) => f.rule);
}

const job = (steps: string) =>
  `on: push\njobs:\n  scan:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
const DIGEST = `@sha256:${'a'.repeat(64)}`;

describe('check-ci-invariants', () => {
  it('passes the real repository', () => {
    expect(checkCiInvariantsFiles(REAL_ROOT)).toEqual([]);
  });

  it.each([
    'pnpm@11.27.1',
    'pnpm@11.27.x+sha512.abc',
    `pnpm@11.27+sha512.${'a'.repeat(128)}`,
    `npm@11.0.0+sha512.${'a'.repeat(128)}`,
    undefined,
  ])('fails on packageManager %s (no exact version with +sha512)', (packageManager) => {
    expect(rules({ pkg: { ...realPkg, packageManager } })).toContain('ci/package-manager');
  });

  it('fails when a range or history scan has no fetch-depth: 0', () => {
    const shallow = realCi.replace('          fetch-depth: 0\n', '');
    expect(shallow).not.toBe(realCi);
    expect(rules({ ci: shallow })).toEqual(['ci/fetch-depth']);
    expect(
      rules({
        ci: job(
          '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 1\n      - run: pnpm secret-scan history\n',
        ),
      }),
    ).toEqual(['ci/fetch-depth']);
  });

  it.each([
    'gitleaks dir . --redact',
    './.tools/gitleaks/8.30.1/gitleaks git --log-opts="a..b" --redact',
    'gitleaks detect --source . \\\n  --redact',
    '"$BIN" gitleaks protect --staged',
  ])('fails on a gitleaks call without --config: %s', (command) => {
    expect(
      rules({ ci: job(`      - run: |\n          ${command.replace(/\n/g, '\n          ')}\n`) }),
    ).toContain('ci/gitleaks-config');
    expect(rules({ scripts: { '.githooks/pre-commit': `#!/bin/sh\n${command}\n` } })).toContain(
      'ci/gitleaks-config',
    );
  });

  it.each([
    'gitleaks dir . --config .gitleaks.toml --redact',
    'gitleaks git --config=.gitleaks.toml',
    'gitleaks git -c .gitleaks.toml \\\n  --redact',
    '# gitleaks dir . (comment only)',
    'node tooling/repo-scripts/src/secret-scan-cli.ts tree',
  ])('accepts %s', (command) => {
    expect(rules({ scripts: { 'tooling/repo-scripts/bin/x.sh': `${command}\n` } })).toEqual([]);
  });

  it.each([
    [
      'top level',
      realCi.replace(
        "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
        'cancel-in-progress: true',
      ),
    ],
    [
      'a job',
      job('      - run: echo hi\n').replace(
        '    runs-on:',
        '    concurrency:\n      group: x\n      cancel-in-progress: true\n    runs-on:',
      ),
    ],
  ])('fails on an unconditional cancel-in-progress (%s)', (_, ci) => {
    expect(rules({ ci })).toContain('ci/cancel-in-progress');
  });

  it('fails when the secret-scan job installs or builds', () => {
    const ci = realCi.replace(
      '      - name: Install gitleaks\n        run: sh tooling/repo-scripts/bin/install-tool.sh gitleaks\n      # Fails on an empty range',
      '      - name: Install gitleaks\n        run: sh tooling/repo-scripts/bin/install-tool.sh gitleaks\n      - run: pnpm install --frozen-lockfile\n      # Fails on an empty range',
    );
    expect(ci).not.toBe(realCi);
    expect(rules({ ci })).toEqual(['ci/secret-scan-no-install']);
  });

  describe('Playwright image digests', () => {
    const e2e = (image: string) =>
      job(`      - run: echo\n    container:\n      image: ${image}\n`);

    it('one digest in CI and e2e-update.sh passes', () => {
      const image = `mcr.microsoft.com/playwright:v1.63.0-noble${DIGEST}`;
      expect(
        rules({
          ci: e2e(image),
          scripts: { 'apps/ui-lab/scripts/e2e-update.sh': `docker run ${image}\n` },
        }),
      ).toEqual([]);
    });

    it('different digests fail', () => {
      expect(
        rules({
          ci: e2e(`mcr.microsoft.com/playwright:v1.63.0-noble${DIGEST}`),
          scripts: {
            'apps/ui-lab/scripts/e2e-update.sh': `docker run mcr.microsoft.com/playwright:v1.63.0-noble@sha256:${'b'.repeat(64)}\n`,
          },
        }),
      ).toEqual(['ci/playwright-digest']);
    });

    it('a tag without a digest fails', () => {
      expect(rules({ ci: e2e('mcr.microsoft.com/playwright:v1.63.0-noble') })).toEqual([
        'ci/playwright-digest',
      ]);
    });
  });
});
