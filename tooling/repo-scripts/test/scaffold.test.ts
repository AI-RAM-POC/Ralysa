// Scaffold unit tests, and TC-F-001-46 (RC-6; AC-1): every template, scaffolded into a copy of the
// repo, passes check-workspaces, lint, typecheck, test and build; an isomorphic package that
// imports node:fs fails lint and one that touches `document` fails typecheck.
//
// The copy gets no `pnpm install` (that would need registry metadata, so the test wouldn't be
// hermetic). Each scaffolded package's node_modules is a symlink to a real workspace with the same
// dependency set instead: apps/web (created from the app template) for the React kinds and
// tooling/repo-scripts for the Node kinds. Scripts run directly with that .bin on PATH.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkWorkspaces } from '../src/check-workspaces.ts';
import { listWorkspaceDirs, readJson } from '../src/lib/repo.ts';
import { formatRootTsconfig, type ScaffoldKind, scaffold } from '../src/scaffold.ts';
import { makeFixtureRepo, validWorkspacePackage } from './fixture-repo.ts';
import { cleanEnv, copyRepo, REAL_ROOT } from './repo-copy.ts';

const placeholder = (name: string) =>
  validWorkspacePackage(name, {
    ralysa: { kind: 'placeholder', shipped: true, ui: false, artefacts: [] },
  });

describe('scaffold: target and kind validation', () => {
  const fixture = () => {
    const repo = makeFixtureRepo({
      workspaces: [
        {
          dir: 'services/agent-host',
          pkg: placeholder('@ralysa/agent-host'),
          files: { 'README.md': '# agent-host\n\nPurpose.\n' },
        },
        { dir: 'services/real', pkg: validWorkspacePackage('@ralysa/real') },
      ],
    });
    repo.write('tsconfig.json', formatRootTsconfig(['tooling/repo-scripts']));
    return repo;
  };

  it.each([
    ['apps/Web', 'app', /kebab-case/],
    ['tools/x', 'service', /apps\/<name>/],
    ['apps/web/nested', 'app', /apps\/<name>/],
    ['packages/x', 'service', /belongs under services\//],
    ['apps/x', 'library', /belongs under packages\//],
    ['services/x', 'widget', /unknown kind/],
  ])('rejects %s --kind %s', (target, kind, message) => {
    expect(() =>
      scaffold({ root: fixture().root, target, kind: kind as ScaffoldKind, repoFiles: [] }),
    ).toThrow(message);
  });

  it('refuses to overwrite a real package', () => {
    expect(() =>
      scaffold({ root: fixture().root, target: 'services/real', kind: 'service', repoFiles: [] }),
    ).toThrow(/already a real package/);
  });

  it('refuses a placeholder that already holds code', () => {
    const repo = fixture();
    expect(() =>
      scaffold({
        root: repo.root,
        target: 'services/agent-host',
        kind: 'service',
        repoFiles: ['services/agent-host/package.json', 'services/agent-host/src/x.ts'],
      }),
    ).toThrow(/src\/x\.ts/);
  });

  it('converts a placeholder, keeps its README and adds the root reference', () => {
    const repo = fixture();
    const result = scaffold({
      root: repo.root,
      target: 'services/agent-host',
      kind: 'service',
      repoFiles: ['services/agent-host/package.json', 'services/agent-host/README.md'],
    });
    expect(result.packageName).toBe('@ralysa/agent-host');
    expect(result.written).not.toContain('services/agent-host/README.md');
    expect(readFileSync(join(repo.root, 'services/agent-host/README.md'), 'utf8')).toContain(
      'Purpose.',
    );
    const pkg = readJson(join(repo.root, 'services/agent-host/package.json')) as {
      name: string;
      ralysa: { kind: string };
    };
    expect(pkg.name).toBe('@ralysa/agent-host');
    expect(pkg.ralysa.kind).toBe('service');
    expect(readFileSync(join(repo.root, 'tsconfig.json'), 'utf8')).toBe(
      formatRootTsconfig(['services/agent-host', 'tooling/repo-scripts']),
    );
    expect(readFileSync(join(repo.root, 'services/agent-host/src/index.ts'), 'utf8')).not.toMatch(
      /\{\{\w+\}\}/,
    );
  });

  it('the real root tsconfig.json is in the format scaffold writes', () => {
    const refs = listWorkspaceDirs(REAL_ROOT).filter((dir) =>
      existsSync(join(REAL_ROOT, dir, 'tsconfig.json')),
    );
    expect(readFileSync(join(REAL_ROOT, 'tsconfig.json'), 'utf8')).toBe(formatRootTsconfig(refs));
  });
});

const KINDS: { kind: ScaffoldKind; target: string; modules: string }[] = [
  { kind: 'library', target: 'packages/demo-lib', modules: 'apps/web' },
  { kind: 'library-isomorphic', target: 'packages/demo-iso', modules: 'tooling/repo-scripts' },
  { kind: 'service', target: 'services/demo-svc', modules: 'tooling/repo-scripts' },
  { kind: 'app', target: 'apps/demo-app', modules: 'apps/web' },
  { kind: 'cli', target: 'apps/demo-cli', modules: 'tooling/repo-scripts' },
];

function runScript(root: string, target: string, script: string): { ok: boolean; output: string } {
  const pkg = readJson(join(root, target, 'package.json')) as { scripts: Record<string, string> };
  const command = pkg.scripts[script];
  if (command === undefined) return { ok: false, output: `no ${script} script` };
  const bin = join(root, target, 'node_modules', '.bin');
  try {
    const output = execSync(command, {
      cwd: join(root, target),
      encoding: 'utf8',
      env: cleanEnv({ PATH: `${bin}:${process.env.PATH ?? ''}` }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output };
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${stdout}\n${stderr}` };
  }
}

describe('scaffold templates pass every gate on creation (TC-F-001-46)', () => {
  const root = copyRepo('ralysa-scaffold-');
  for (const { kind, target, modules } of KINDS) {
    scaffold({ root, target, kind, repoFiles: [] });
    symlinkSync(
      join(REAL_ROOT, modules, 'node_modules'),
      join(root, target, 'node_modules'),
      'dir',
    );
  }

  it('check-workspaces accepts all five new packages', () => {
    const dirs = listWorkspaceDirs(root);
    const findings = checkWorkspaces({ root, pnpmWorkspaces: dirs, repoFiles: [] });
    expect(findings).toEqual([]);
  });

  describe.each(KINDS)('$kind ($target)', ({ target }) => {
    it.each(['lint', 'typecheck', 'test', 'build'])('%s passes', (script) => {
      const result = runScript(root, target, script);
      expect(result.ok, result.output).toBe(true);
    });
  });

  it('the build emits dist/ for every kind', () => {
    for (const { target } of KINDS)
      expect(existsSync(join(root, target, 'dist')), target).toBe(true);
  });

  it('an isomorphic package that imports node:fs fails lint', () => {
    const file = join(root, 'packages/demo-iso/src/uses-node.ts');
    writeFileSync(
      file,
      "import { readFileSync } from 'node:fs';\n\nexport const read = readFileSync;\n",
    );
    const result = runScript(root, 'packages/demo-iso', 'lint');
    expect(result.ok).toBe(false);
    expect(result.output).toContain('no-restricted-imports');
  });

  it('an isomorphic package that touches document fails typecheck', () => {
    writeFileSync(join(root, 'packages/demo-iso/src/uses-node.ts'), 'export {};\n');
    writeFileSync(
      join(root, 'packages/demo-iso/src/uses-dom.ts'),
      'export const title = document.title;\n',
    );
    const result = runScript(root, 'packages/demo-iso', 'typecheck');
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Cannot find name 'document'/);
  });
});
