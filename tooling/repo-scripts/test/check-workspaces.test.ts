// TC-F-001-01 (unit part), TC-F-001-43, and the lifecycle/specifier parts of TC-F-001-42.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkWorkspaces, exoticSpecifierKind } from '../src/check-workspaces.ts';
import { findRepoRoot } from '../src/lib/repo.ts';
import { type FixtureWorkspace, makeFixtureRepo, validWorkspacePackage } from './fixture-repo.ts';

const TOOLING = 'tooling/repo-scripts';

function run(
  options: Parameters<typeof makeFixtureRepo>[0] = {},
  extra: {
    repoFiles?: string[];
    setup?: (fixture: ReturnType<typeof makeFixtureRepo>) => void;
  } = {},
) {
  const fixture = makeFixtureRepo(options);
  extra.setup?.(fixture);
  const dirs = [TOOLING, ...(options.workspaces ?? []).map((w) => w.dir)];
  return checkWorkspaces({
    root: fixture.root,
    pnpmWorkspaces: dirs,
    repoFiles: extra.repoFiles ?? [],
    specifierAllowlist: [],
  });
}

const rules = (findings: { rule: string }[]): string[] => findings.map((f) => f.rule);

const service = (overrides: Record<string, unknown> = {}): FixtureWorkspace => ({
  dir: 'services/demo',
  pkg: validWorkspacePackage('@ralysa/demo', overrides),
});

describe('check-workspaces: coverage (TC-F-001-01)', () => {
  it('passes a well-formed fixture repo', () => {
    expect(run({ workspaces: [service()] })).toEqual([]);
  });

  it('fails on a workspace folder without package.json', () => {
    const findings = run(
      {},
      {
        setup: (f) => {
          mkdirSync(join(f.root, 'apps', 'orphan'), { recursive: true });
        },
      },
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'workspace/missing-package-json', path: 'apps/orphan' }),
    );
  });

  it('fails on a workspace pnpm does not list', () => {
    const fixture = makeFixtureRepo({ workspaces: [service()] });
    const findings = checkWorkspaces({
      root: fixture.root,
      pnpmWorkspaces: [TOOLING],
      repoFiles: [],
      specifierAllowlist: [],
    });
    expect(rules(findings)).toContain('workspace/not-in-pnpm');
  });

  it.each(['lint', 'typecheck', 'test', 'build'])(
    'fails when the %s script is missing',
    (script) => {
      const scripts = {
        ...(validWorkspacePackage('@ralysa/demo').scripts as Record<string, string>),
      };
      const pkg = validWorkspacePackage('@ralysa/demo', {
        scripts: Object.fromEntries(Object.entries(scripts).filter(([name]) => name !== script)),
      });
      const findings = run({ workspaces: [{ dir: 'services/demo', pkg }] });
      expect(findings).toContainEqual(
        expect.objectContaining({
          rule: 'workspace/missing-script',
          message: expect.stringContaining(`"${script}"`),
        }),
      );
    },
  );

  it('fails the §3.1 schema: bad name, not private, library without runtime, shipped tooling', () => {
    expect(rules(run({ workspaces: [service({ name: 'demo' })] }))).toContain('workspace/schema');
    expect(rules(run({ workspaces: [service({ private: false })] }))).toContain('workspace/schema');
    const library = service({ ralysa: { kind: 'library', shipped: false, ui: false } });
    expect(run({ workspaces: [library] })).toContainEqual(
      expect.objectContaining({
        rule: 'workspace/schema',
        message: expect.stringContaining('runtime'),
      }),
    );
    const tooling = service({ ralysa: { kind: 'tooling', shipped: true, ui: false } });
    expect(run({ workspaces: [tooling] })).toContainEqual(
      expect.objectContaining({
        rule: 'workspace/schema',
        message: expect.stringContaining('never shipped'),
      }),
    );
    const unknownKey = service({ ralysa: { kind: 'service', shipped: true, ui: false, extra: 1 } });
    expect(rules(run({ workspaces: [unknownKey] }))).toContain('workspace/schema');
  });
});

describe('check-workspaces: lifecycle scripts (TC-F-001-43, SEC-F001-11)', () => {
  it.each(['postinstall', 'prepare', 'preinstall', 'install', 'prepack', 'prepublishOnly'])(
    'fails on a workspace %s script',
    (script) => {
      const pkg = validWorkspacePackage('@ralysa/demo');
      (pkg.scripts as Record<string, string>)[script] = 'node evil.js';
      expect(rules(run({ workspaces: [{ dir: 'services/demo', pkg }] }))).toContain(
        'lifecycle/script',
      );
    },
  );

  it('fails on a root postinstall', () => {
    const findings = run({
      rootPkg: { name: 'ralysa', private: true, scripts: { postinstall: 'curl x | sh' } },
    });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'lifecycle/script', path: 'package.json' }),
    );
  });

  it('passes an allow-listed lifecycle script only when the command matches exactly', () => {
    const pkg = validWorkspacePackage('@ralysa/demo');
    (pkg.scripts as Record<string, string>).prepare = 'node scripts/setup.js';
    const entry = {
      package: '@ralysa/demo',
      script: 'prepare',
      command: 'node scripts/setup.js',
      owner: 'x',
      reason: 'y',
    };
    expect(run({ workspaces: [{ dir: 'services/demo', pkg }], lifecycleEntries: [entry] })).toEqual(
      [],
    );
    const changed = { ...entry, command: 'node scripts/other.js' };
    expect(
      rules(run({ workspaces: [{ dir: 'services/demo', pkg }], lifecycleEntries: [changed] })),
    ).toContain('lifecycle/script');
  });
});

describe('check-workspaces: pnpm build settings (TC-F-001-43, SEC-F001-19)', () => {
  const yaml = (extra: string): string => `packages:\n  - "apps/*"\n  - "tooling/*"\n${extra}`;

  it('fails on enablePrePostScripts: true', () => {
    expect(rules(run({ workspaceYaml: yaml('enablePrePostScripts: true\n') }))).toContain(
      'pnpm/enable-pre-post-scripts',
    );
  });

  it('fails on dangerouslyAllowAllBuilds anywhere pnpm reads settings', () => {
    expect(rules(run({ workspaceYaml: yaml('dangerouslyAllowAllBuilds: true\n') }))).toContain(
      'pnpm/dangerously-allow-all-builds',
    );
    const viaNpmrc = run(
      {},
      {
        setup: (f) => {
          f.write('.npmrc', 'dangerously-allow-all-builds=true\n');
        },
      },
    );
    expect(rules(viaNpmrc)).toContain('pnpm/dangerously-allow-all-builds');
  });

  it('fails on allowBuilds: true without a reviewed allow-builds.json entry, and passes with one', () => {
    const withBuild = yaml('allowBuilds:\n  esbuild: true\n  "@swc/core": false\n');
    expect(run({ workspaceYaml: withBuild })).toContainEqual(
      expect.objectContaining({
        rule: 'pnpm/allow-builds',
        message: expect.stringContaining('esbuild'),
      }),
    );
    const reviewed = [
      { package: 'esbuild', reason: 'native binary', reviewer: 'sec', date: '2026-09-25' },
    ];
    expect(run({ workspaceYaml: withBuild, allowBuildsEntries: reviewed })).toEqual([]);
  });

  it('fails when packs/* is a workspace glob (RF-7)', () => {
    expect(rules(run({ workspaceYaml: 'packages:\n  - "tooling/*"\n  - "packs/*"\n' }))).toContain(
      'pnpm/packs-in-workspace',
    );
  });
});

describe('check-workspaces: dependency specifiers (TC-F-001-42, SEC-F001-09 a, -26)', () => {
  it.each([
    ['npm:openai@4.0.0', 'npm: alias'],
    ['file:../lib', 'file:'],
    ['link:../lib', 'link:'],
    ['portal:../lib', 'portal:'],
    ['git+https://github.com/o/r.git', 'git'],
    ['git@github.com:o/r.git', 'git'],
    ['github:o/r', 'hosted git'],
    ['https://example.com/pkg.tgz', 'tarball URL'],
    ['o/r#main', 'GitHub shorthand'],
  ])('flags %s as %s', (specifier, kind) => {
    expect(exoticSpecifierKind(specifier)).toBe(kind);
    const pkg = validWorkspacePackage('@ralysa/demo', { dependencies: { llm: specifier } });
    expect(rules(run({ workspaces: [{ dir: 'services/demo', pkg }] }))).toContain(
      'deps/exotic-specifier',
    );
  });

  it.each(['1.2.3', '^1.2.3', '~1.2', '>=1 <2', 'catalog:', 'latest', '*'])(
    'accepts %s',
    (specifier) => {
      expect(exoticSpecifierKind(specifier)).toBeUndefined();
    },
  );

  it('checks the root package.json and pnpm overrides too', () => {
    const findings = run({
      rootPkg: {
        name: 'ralysa',
        private: true,
        devDependencies: { x: 'npm:openai@4' },
        pnpm: { overrides: { y: 'github:o/r' } },
      },
    });
    expect(
      findings.filter((f) => f.rule === 'deps/exotic-specifier' && f.path === 'package.json'),
    ).toHaveLength(2);
  });

  it('allows an exotic specifier only when boundaries.js lists it', () => {
    const fixture = makeFixtureRepo({
      workspaces: [
        {
          dir: 'services/demo',
          pkg: validWorkspacePackage('@ralysa/demo', { dependencies: { x: 'github:o/r' } }),
        },
      ],
    });
    const findings = checkWorkspaces({
      root: fixture.root,
      pnpmWorkspaces: [TOOLING, 'services/demo'],
      repoFiles: [],
      specifierAllowlist: [
        { workspace: 'services/demo', dependency: 'x', specifier: 'github:o/r', reason: 'fork' },
      ],
    });
    expect(findings).toEqual([]);
  });

  it.each([
    'file:../../packs/finance',
    'link:../../packs/hr',
    'portal:../../packs/soc',
    '../../packs/legal',
  ])('rejects %s into packs/ even when allow-listed', (specifier) => {
    const fixture = makeFixtureRepo({
      workspaces: [
        {
          dir: 'services/demo',
          pkg: validWorkspacePackage('@ralysa/demo', { dependencies: { p: specifier } }),
        },
      ],
    });
    const findings = checkWorkspaces({
      root: fixture.root,
      pnpmWorkspaces: [TOOLING, 'services/demo'],
      repoFiles: [],
      specifierAllowlist: [
        { workspace: 'services/demo', dependency: 'p', specifier, reason: 'nope' },
      ],
    });
    expect(rules(findings)).toContain('deps/packs');
  });

  it('requires workspace:* for @ralysa dependencies and keeps tooling in devDependencies', () => {
    const pkg = validWorkspacePackage('@ralysa/demo', {
      dependencies: { '@ralysa/repo-scripts': 'workspace:*' },
      devDependencies: { '@ralysa/other': '^1.0.0' },
    });
    const found = rules(run({ workspaces: [{ dir: 'services/demo', pkg }] }));
    expect(found).toContain('deps/internal-workspace-protocol');
    expect(found).toContain('deps/tooling-dev-only');
  });
});

describe('check-workspaces: Python ban (TC-F-001-43, RC-7)', () => {
  it.each([
    'services/extraction/main.py',
    'services/model-gateway/pyproject.toml',
    'requirements-dev.txt',
    'services/extraction/requirements.txt',
    'tools/Pipfile',
    'setup.cfg',
    'uv.lock',
  ])('fails on %s', (file) => {
    expect(rules(run({}, { repoFiles: [file] }))).toContain('python/file');
  });

  it('ignores docs/ and requirements/ and look-alikes', () => {
    const files = [
      'docs/examples/snippet.py',
      'requirements/spec-appendix.py',
      'src/pyproject.toml.md',
      'a.pyc.txt',
    ];
    expect(run({}, { repoFiles: files })).toEqual([]);
  });
});

describe('check-workspaces: register files', () => {
  it('fails when a register entry is malformed', () => {
    const findings = run({ allowBuildsEntries: [{ package: 'esbuild' }] });
    expect(rules(findings)).toContain('registers/schema');
  });

  it('the real registers parse', () => {
    const root = findRepoRoot();
    const findings = checkWorkspaces({
      root,
      pnpmWorkspaces: [],
      repoFiles: [],
      specifierAllowlist: [],
    });
    expect(findings.filter((f) => f.rule.startsWith('registers/'))).toEqual([]);
  });
});
