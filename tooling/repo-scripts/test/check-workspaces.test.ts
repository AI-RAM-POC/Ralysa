// TC-F-001-01 (unit part), TC-F-001-43, and the lifecycle/specifier parts of TC-F-001-42.
import { createHash } from 'node:crypto';
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

describe('check-workspaces: pnpm-workspace.yaml catalogs and overrides (code review M1)', () => {
  const base = 'packages:\n  - "apps/*"\n  - "tooling/*"\n';

  it.each([
    ['catalog', 'catalog:\n  zod: "npm:openai@4.0.0"\n', 'deps/exotic-specifier'],
    ['catalog', 'catalog:\n  zod: "github:o/r"\n', 'deps/exotic-specifier'],
    ['catalog', 'catalog:\n  zod: "https://example.com/zod.tgz"\n', 'deps/exotic-specifier'],
    ['catalog', 'catalog:\n  zod: "git+https://github.com/o/r.git"\n', 'deps/exotic-specifier'],
    ['catalog', 'catalog:\n  finance: "file:packs/finance"\n', 'deps/packs'],
    ['catalogs.*', 'catalogs:\n  react18:\n    react: "npm:preact@10"\n', 'deps/exotic-specifier'],
    ['catalogs.*', 'catalogs:\n  local:\n    hr: "link:./packs/hr"\n', 'deps/packs'],
    ['overrides', 'overrides:\n  zod: "github:o/r"\n', 'deps/exotic-specifier'],
    ['overrides', 'overrides:\n  "a>b": "npm:evil@1"\n', 'deps/exotic-specifier'],
    ['overrides', 'overrides:\n  soc: "portal:packs/soc"\n', 'deps/packs'],
  ])('flags an exotic %s value: %j', (_field, yaml, rule) => {
    const findings = run({ workspaceYaml: base + yaml });
    expect(findings).toContainEqual(expect.objectContaining({ rule, path: 'pnpm-workspace.yaml' }));
  });

  it('accepts registry versions in catalog, catalogs and overrides', () => {
    const yaml =
      base +
      'catalog:\n  zod: 4.6.5\n  react: ^19.3.0\ncatalogs:\n  legacy:\n    react: 18.3.1\noverrides:\n  semver: ">=7.5.2"\n  "foo>bar": "-"\n';
    expect(run({ workspaceYaml: yaml })).toEqual([]);
  });

  it('allows a catalog value only when boundaries.js lists it, and never into packs/', () => {
    const fixture = makeFixtureRepo({
      workspaceYaml: `${base}catalog:\n  x: "github:o/r"\n  p: "file:packs/legal"\n`,
    });
    const findings = checkWorkspaces({
      root: fixture.root,
      pnpmWorkspaces: [TOOLING],
      repoFiles: [],
      specifierAllowlist: [
        {
          workspace: 'pnpm-workspace.yaml',
          dependency: 'x',
          specifier: 'github:o/r',
          reason: 'fork',
        },
        {
          workspace: 'pnpm-workspace.yaml',
          dependency: 'p',
          specifier: 'file:packs/legal',
          reason: 'no',
        },
      ],
    });
    expect(rules(findings)).toEqual(['deps/packs']);
  });
});

describe('check-workspaces: install-time hooks (code review M2)', () => {
  it('fails on a root pnpm:devPreinstall script unless allow-listed', () => {
    const rootPkg = {
      name: 'ralysa',
      private: true,
      scripts: { 'pnpm:devPreinstall': 'node x.js' },
    };
    expect(run({ rootPkg })).toContainEqual(
      expect.objectContaining({
        rule: 'lifecycle/script',
        message: expect.stringContaining('pnpm:devPreinstall') as string,
      }),
    );
    const entry = {
      package: 'ralysa',
      script: 'pnpm:devPreinstall',
      command: 'node x.js',
      owner: 'o',
      reason: 'r',
    };
    expect(run({ rootPkg, lifecycleEntries: [entry] })).toEqual([]);
  });

  it.each(['.pnpmfile.cjs', '.pnpmfile.mjs', 'pnpmfile.js', 'tools/.pnpmfile.cjs'])(
    'fails on an unreviewed %s',
    (file) => {
      const findings = run(
        {},
        {
          repoFiles: [file],
          setup: (f) => {
            f.write(file, 'module.exports = { hooks: {} };\n');
          },
        },
      );
      expect(findings).toContainEqual(
        expect.objectContaining({ rule: 'pnpm/pnpmfile', path: file }),
      );
    },
  );

  it('fails on a pnpmfile setting pointing at an unreviewed file, outside the repo, or a global pnpmfile', () => {
    const yaml = (extra: string) => `packages:\n  - "tooling/*"\n${extra}`;
    const named = run(
      { workspaceYaml: yaml('pnpmfile: hooks/install.cjs\n') },
      {
        setup: (f) => {
          f.write('hooks/install.cjs', 'module.exports = {};\n');
        },
      },
    );
    expect(named).toContainEqual(
      expect.objectContaining({ rule: 'pnpm/pnpmfile', path: 'hooks/install.cjs' }),
    );
    expect(rules(run({ workspaceYaml: yaml('pnpmfile: ../outside.cjs\n') }))).toContain(
      'pnpm/pnpmfile',
    );
    expect(rules(run({ workspaceYaml: yaml('globalPnpmfile: /etc/hooks.cjs\n') }))).toContain(
      'pnpm/pnpmfile',
    );
    const npmrc = run(
      {},
      {
        setup: (f) => {
          f.write('.npmrc', 'global-pnpmfile=/tmp/x.cjs\n');
        },
      },
    );
    expect(rules(npmrc)).toContain('pnpm/pnpmfile');
  });

  it('passes a reviewed pnpmfile only while its content hash matches', () => {
    const content = 'module.exports = { hooks: {} };\n';
    const sha256 = createHash('sha256').update(content).digest('hex');
    const entry = { path: '.pnpmfile.cjs', sha256, owner: 'o', reason: 'r', date: '2026-09-25' };
    const reviewed = run(
      { pnpmfileEntries: [entry] },
      {
        repoFiles: ['.pnpmfile.cjs'],
        setup: (f) => {
          f.write('.pnpmfile.cjs', content);
        },
      },
    );
    expect(reviewed).toEqual([]);
    const edited = run(
      { pnpmfileEntries: [entry] },
      {
        repoFiles: ['.pnpmfile.cjs'],
        setup: (f) => {
          f.write('.pnpmfile.cjs', `${content}// changed\n`);
        },
      },
    );
    expect(edited).toContainEqual(
      expect.objectContaining({
        rule: 'pnpm/pnpmfile',
        message: expect.stringContaining('content changed') as string,
      }),
    );
  });
});

describe('check-workspaces: workspaces outside the four roots (code review m1)', () => {
  it('flags a workspace pnpm lists outside apps/, packages/, services/ and tooling/', () => {
    const fixture = makeFixtureRepo();
    const findings = checkWorkspaces({
      root: fixture.root,
      pnpmWorkspaces: [TOOLING, 'deploy/docker'],
      repoFiles: [],
      specifierAllowlist: [],
    });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'workspace/outside-roots', path: 'deploy/docker' }),
    );
  });

  it.each([
    ['*/*', ['deploy/docker', 'packs/finance']],
    ['deploy/*', ['deploy/docker']],
    ['**', ['deploy/docker', 'packs/finance']],
    ['./packs/**', ['packs/finance']],
  ])('resolves the glob %s itself and flags %j even when pnpm is not asked', (glob, expected) => {
    const fixture = makeFixtureRepo({
      workspaceYaml: `packages:\n  - "tooling/*"\n  - "${glob}"\n`,
    });
    fixture.writeJson('deploy/docker/package.json', { name: 'docker' });
    fixture.writeJson('packs/finance/package.json', { name: 'finance' });
    fixture.writeJson('deploy/docker/node_modules/x/package.json', { name: 'x' });
    const findings = checkWorkspaces({
      root: fixture.root,
      pnpmWorkspaces: [TOOLING],
      repoFiles: [],
      specifierAllowlist: [],
    });
    const outside = findings.filter((f) => f.rule === 'workspace/outside-roots').map((f) => f.path);
    expect(outside).toEqual(expected);
  });

  it('honours negated globs', () => {
    const fixture = makeFixtureRepo({
      workspaceYaml: 'packages:\n  - "tooling/*"\n  - "deploy/*"\n  - "!deploy/docker"\n',
    });
    fixture.writeJson('deploy/docker/package.json', { name: 'docker' });
    const findings = checkWorkspaces({
      root: fixture.root,
      pnpmWorkspaces: [TOOLING],
      repoFiles: [],
      specifierAllowlist: [],
    });
    expect(rules(findings)).not.toContain('workspace/outside-roots');
  });
});

describe('check-workspaces: pnpm configDependencies (code review N1)', () => {
  // Synthetic integrity values: format-valid, never issued for any real package.
  const integrity = `sha512-${'A'.repeat(86)}==`;
  const other = `sha512-${'B'.repeat(86)}==`;
  const yaml = (deps: string) => `packages:\n  - "tooling/*"\nconfigDependencies:\n${deps}`;

  it.each([
    ['a bare plugin name', 'pnpm-plugin-evil', true],
    ['an @pnpm/plugin-* name', '@pnpm/plugin-evil', true],
    ['a scoped plugin name', '@acme/pnpm-plugin-evil', true],
    ['a non-plugin config dependency', '@acme/shared-config', false],
  ])('fails on %s', (_label, name, plugin) => {
    const findings = run({ workspaceYaml: yaml(`  "${name}": "1.0.0+${integrity}"\n`) });
    const finding = findings.find((f) => f.rule === 'pnpm/config-dependencies');
    expect(finding?.message).toContain(`configDependencies.${name}`);
    expect(finding?.message.includes('pnpm plugin name')).toBe(plugin);
  });

  it('passes a registered entry only for the exact version and integrity', () => {
    const entry = {
      package: '@acme/pnpm-plugin-catalogs',
      specifier: `1.0.0+${integrity}`,
      owner: 'tech lead',
      reason: 'shared catalogs',
    };
    const registered = yaml(`  "@acme/pnpm-plugin-catalogs": "1.0.0+${integrity}"\n`);
    expect(run({ workspaceYaml: registered, configDependencyEntries: [entry] })).toEqual([]);
    const bumped = yaml(`  "@acme/pnpm-plugin-catalogs": "1.0.1+${integrity}"\n`);
    expect(rules(run({ workspaceYaml: bumped, configDependencyEntries: [entry] }))).toContain(
      'pnpm/config-dependencies',
    );
    const swapped = yaml(`  "@acme/pnpm-plugin-catalogs": "1.0.0+${other}"\n`);
    expect(rules(run({ workspaceYaml: swapped, configDependencyEntries: [entry] }))).toContain(
      'pnpm/config-dependencies',
    );
  });

  it('checks the object form and rejects a non-mapping value', () => {
    const objectForm = yaml(`  pnpm-plugin-x:\n    version: 1.0.0\n    integrity: ${integrity}\n`);
    expect(rules(run({ workspaceYaml: objectForm }))).toContain('pnpm/config-dependencies');
    const list = 'packages:\n  - "tooling/*"\nconfigDependencies:\n  - pnpm-plugin-x\n';
    expect(rules(run({ workspaceYaml: list }))).toContain('pnpm/config-dependencies');
  });

  it('rejects a malformed register entry', () => {
    const bad = { package: 'x', specifier: '1.0.0', owner: 'o', reason: 'r' };
    expect(rules(run({ configDependencyEntries: [bad] }))).toContain('registers/schema');
  });
});
