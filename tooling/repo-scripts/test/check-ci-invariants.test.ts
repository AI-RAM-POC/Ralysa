// TC-F-001-44, check-ci-invariants part (SEC-F001-06, -20, -21).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
          '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 1\n      - run: node tooling/repo-scripts/src/secret-scan-cli.ts history\n',
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
    // The secret-scan job has no pre-install gate, so the install also trips that rule.
    expect(rules({ ci }).sort()).toEqual([
      'ci/pre-install-gate-first',
      'ci/secret-scan-no-install',
    ]);
  });

  describe('ci/pre-install-gate-first (F-002-T02, SEC-F002-28)', () => {
    const GATE = '      - run: node tooling/repo-scripts/src/pre-install-gate.ts\n';
    const SETUP_NODE_PNPM_CACHE =
      '      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .nvmrc\n          cache: pnpm\n';

    it.each([
      ['pnpm install before the gate', `      - run: pnpm install --frozen-lockfile\n${GATE}`],
      [
        'corepack before the gate',
        `      - run: |\n          corepack enable\n          pnpm --version\n${GATE}`,
      ],
      [
        'pnpm inside $(…) before the gate',
        `      - run: echo "p=$(pnpm store path)" >> "$GITHUB_OUTPUT"\n${GATE}`,
      ],
      ['npx with no gate at all', '      - run: npx turbo run build\n'],
      ['turbo before the gate', `      - run: turbo run test\n${GATE}`],
      ['setup-node with cache: pnpm before the gate', `${SETUP_NODE_PNPM_CACHE}${GATE}`],
      ['pnpm/action-setup before the gate', `      - uses: pnpm/action-setup@v4\n${GATE}`],
      [
        'pnpm on a line before the gate in the same step',
        '      - run: |\n          pnpm --version\n          node tooling/repo-scripts/src/pre-install-gate.ts\n',
      ],
    ])('fails on %s', (_label, steps) => {
      expect(rules({ ci: job(steps) })).toEqual(['ci/pre-install-gate-first']);
    });

    it.each([
      ['the gate, then pnpm', `${GATE}      - run: pnpm install --frozen-lockfile\n`],
      ['the gate, then setup-node with a cache', `${GATE}${SETUP_NODE_PNPM_CACHE}`],
      [
        'the gate and pnpm in one step, in that order',
        '      - run: |\n          node tooling/repo-scripts/src/pre-install-gate.ts\n          pnpm install\n',
      ],
      [
        'no package manager at all',
        '      - run: node tooling/repo-scripts/src/secret-scan-cli.ts tree\n',
      ],
      [
        'a mention in a comment line',
        `      - run: |\n          # pnpm comes later\n          echo ok\n`,
      ],
      [
        'setup-node without a cache',
        '      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .nvmrc\n',
      ],
      ['a word that only contains a manager name', '      - run: echo pnpmfile turbofan\n'],
    ])('passes %s', (_label, steps) => {
      expect(rules({ ci: job(steps) })).toEqual([]);
    });

    it('checks every workflow, not only ci.yml', () => {
      const findings = checkCiInvariants({
        packageJson: realPkg,
        workflows: new Map([
          ['.github/workflows/ci.yml', parse(realCi) as unknown],
          ['.github/workflows/soak.yml', parse(job('      - run: pnpm install\n')) as unknown],
        ]),
        scripts: new Map(),
      });
      expect(findings).toEqual([
        expect.objectContaining({
          rule: 'ci/pre-install-gate-first',
          path: '.github/workflows/soak.yml',
        }),
      ]);
    });
  });

  describe('integration job (F-002-T02, SEC-F002-27)', () => {
    const integration = /\n {2}integration:\n[\s\S]*?(?=\n {2}# Secret scanning)/.exec(realCi)?.[0];
    const withJob = (edit: (text: string) => string) => {
      if (integration === undefined) throw new Error('no integration job in ci.yml');
      const edited = edit(integration);
      expect(edited).not.toBe(integration);
      return realCi.replace(integration, edited);
    };

    it('the real job passes', () => {
      expect(integration).toBeDefined();
      expect(rules()).toEqual([]);
    });

    it.each([
      [
        'a secrets.* reference',
        (t: string) =>
          t.replace(
            "RALYSA_REQUIRE_DEV_STACK: '1'",
            "RALYSA_REQUIRE_DEV_STACK: '1'\n      TOKEN: ${{ secrets.NPM_TOKEN }}",
          ),
      ],
      [
        'no permissions block',
        (t: string) => t.replace('    permissions:\n      contents: read\n', ''),
      ],
      ['write permissions', (t: string) => t.replace('contents: read', 'contents: write')],
      [
        'an extra permission',
        (t: string) => t.replace('contents: read', 'contents: read\n      id-token: write'),
      ],
      [
        'a checkout that persists credentials',
        (t: string) => t.replace('          persist-credentials: false\n', ''),
      ],
    ])('fails ci/integration-no-secrets on %s', (_label, edit) => {
      expect(rules({ ci: withJob(edit) })).toEqual(['ci/integration-no-secrets']);
    });

    it.each([
      [
        'OpenBao logs',
        (t: string) => t.replace('logs --no-color postgres', 'logs --no-color postgres openbao'),
      ],
      ['every service', (t: string) => t.replace('logs --no-color postgres', 'logs --no-color')],
      ['no retention limit', (t: string) => t.replace('          retention-days: 3\n', '')],
      ['a long retention', (t: string) => t.replace('retention-days: 3', 'retention-days: 30')],
    ])('fails ci/integration-artefact on %s', (_label, edit) => {
      expect(rules({ ci: withJob(edit) })).toEqual(['ci/integration-artefact']);
    });

    it.each([
      [
        'no image scan step',
        (t: string) =>
          t.replace(
            /\n {6}- name: Image secret scan \(AC-9\)\n[\s\S]*?--exact-values deploy\/docker\/dev\/\.env\n/,
            '\n',
          ),
      ],
      [
        'an image scan without the run credentials',
        (t: string) => t.replace(' --exact-values deploy/docker/dev/.env', ''),
      ],
      [
        'an image scan of another Dockerfile',
        (t: string) =>
          t.replace(
            '--dockerfile deploy/docker/control-plane.Dockerfile',
            '--dockerfile Dockerfile',
          ),
      ],
      [
        'the scan commented out',
        (t: string) =>
          t.replace(
            'run: node tooling/repo-scripts/src/secret-scan-cli.ts image',
            'run: echo skipped # node tooling/repo-scripts/src/secret-scan-cli.ts image',
          ),
      ],
    ])('fails ci/integration-image-scan (F-002-T14) on %s', (_label, edit) => {
      expect(rules({ ci: withJob(edit) })).toEqual(['ci/integration-image-scan']);
    });

    it('requires the pre-install gate before the job installs', () => {
      const ci = withJob((t) =>
        t.replace(
          '      - name: Pre-install config gate\n        run: node tooling/repo-scripts/src/pre-install-gate.ts\n',
          '',
        ),
      );
      expect(rules({ ci })).toEqual(['ci/pre-install-gate-first']);
    });
  });

  describe('Playwright image digests', () => {
    const e2e = (image: string) =>
      job(`      - run: echo\n    container:\n      image: ${image}\n`);

    it('the real ui-e2e job and apps/ui-lab/scripts/e2e-container.sh share one digest', () => {
      const images = (text: string): string[] =>
        [...text.matchAll(/mcr\.microsoft\.com\/playwright:[^\s'"]+/g)].map((m) => m[0]);
      const ci = images(realCi);
      const script = images(
        readFileSync(join(REAL_ROOT, 'apps/ui-lab/scripts/e2e-container.sh'), 'utf8'),
      );
      expect(ci).toHaveLength(1);
      expect(script).toEqual(ci);
    });

    it('every script in apps/ui-lab/scripts/ is read: a stray digest there fails', () => {
      const root = mkdtempSync(join(tmpdir(), 'ralysa-ci-digest-'));
      try {
        cpSync(join(REAL_ROOT, '.github/workflows'), join(root, '.github/workflows'), {
          recursive: true,
        });
        writeFileSync(join(root, 'package.json'), JSON.stringify(realPkg));
        mkdirSync(join(root, 'apps/ui-lab/scripts'), { recursive: true });
        writeFileSync(
          join(root, 'apps/ui-lab/scripts/e2e-other.sh'),
          `docker run mcr.microsoft.com/playwright:v1.63.0-noble@sha256:${'c'.repeat(64)}\n`,
        );
        expect(checkCiInvariantsFiles(root).map((f) => f.rule)).toContain('ci/playwright-digest');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

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
