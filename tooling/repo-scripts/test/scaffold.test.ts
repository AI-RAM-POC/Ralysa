// Scaffold unit tests, and TC-F-001-46 (RC-6; AC-1): every template, scaffolded into a copy of the
// repo, passes check-workspaces, lint, typecheck, test and build; an isomorphic package that
// imports node:fs fails lint and one that touches `document` fails typecheck.
//
// The copy gets no `pnpm install` (that would need registry metadata, so the test wouldn't be
// hermetic). Instead each scaffolded package's node_modules holds only the dependencies its
// template declares, linked to the real repo's installed copies (test/link-deps.ts), so a template
// that forgets one fails here. Scripts run directly with that .bin on PATH.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkTsrefs } from '../src/check-tsrefs.ts';
import { checkWorkspaces } from '../src/check-workspaces.ts';
import { listWorkspaceDirs, readJson } from '../src/lib/repo.ts';
import { formatRootTsconfig, type ScaffoldKind, scaffold } from '../src/scaffold.ts';
import { makeFixtureRepo, validWorkspacePackage } from './fixture-repo.ts';
import { linkDeclaredDependencies } from './link-deps.ts';
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

const KINDS: { kind: ScaffoldKind; target: string }[] = [
  { kind: 'library', target: 'packages/demo-lib' },
  { kind: 'library-isomorphic', target: 'packages/demo-iso' },
  { kind: 'service', target: 'services/demo-svc' },
  { kind: 'app', target: 'apps/demo-app' },
  { kind: 'cli', target: 'apps/demo-cli' },
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
  for (const { kind, target } of KINDS) {
    scaffold({ root, target, kind, repoFiles: [] });
    linkDeclaredDependencies(join(root, target));
  }

  it('check-workspaces accepts all five new packages', () => {
    const findings = checkWorkspaces({ root, repoFiles: [] });
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

// T08-8 (decided): a scaffolded library's typecheck config is referenceable. A scaffolded app that
// depends on it references it (check-tsrefs requires that), and `tsc -b` builds the graph without
// TS6310. A negative control switches the library back to noEmit.
describe('a scaffolded app can reference a scaffolded library (T08-8)', () => {
  const root = copyRepo('ralysa-scaffold-');
  const lib = 'packages/ref-lib';
  const app = 'apps/ref-app';
  scaffold({ root, target: lib, kind: 'library', repoFiles: [] });
  scaffold({ root, target: app, kind: 'app', repoFiles: [] });
  linkDeclaredDependencies(join(root, lib));
  linkDeclaredDependencies(join(root, app));

  // The app depends on, references and imports the library. link-deps resolves @ralysa/* from
  // the real repo, where this library doesn't exist, so it is linked to the copy here.
  const appPkgFile = join(root, app, 'package.json');
  const appPkg = readJson(appPkgFile) as { dependencies: Record<string, string> };
  appPkg.dependencies['@ralysa/ref-lib'] = 'workspace:*';
  writeFileSync(appPkgFile, `${JSON.stringify(appPkg, null, 2)}\n`);
  writeFileSync(
    join(root, app, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: '@ralysa/tsconfig/vite-app.json',
        include: ['src', 'test', '*.config.ts'],
        references: [{ path: '../../packages/ref-lib' }],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, app, 'src/uses-lib.tsx'),
    "import { Slot } from '@ralysa/ref-lib';\n\nexport const LibSlot: typeof Slot = Slot;\n",
  );
  mkdirSync(join(root, app, 'node_modules/@ralysa'), { recursive: true });
  symlinkSync(join(root, lib), join(root, app, 'node_modules/@ralysa/ref-lib'), 'dir');

  const tscBuild = (): { ok: boolean; output: string } => {
    try {
      const output = execSync(`"${join(root, lib, 'node_modules/.bin/tsc')}" -b ${app}`, {
        cwd: root,
        encoding: 'utf8',
        env: cleanEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, output };
    } catch (error) {
      const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
      return { ok: false, output: `${stdout}\n${stderr}` };
    }
  };
  const refFindings = (): string[] =>
    checkTsrefs({ root })
      .filter((f) => f.path.includes('ref-'))
      .map((f) => f.rule);

  it('check-tsrefs accepts the reference', () => {
    expect(refFindings()).toEqual([]);
  });

  it('tsc -b builds the library declarations and type-checks the app against the library', () => {
    // The app imports the package entry point (dist/), as a bundler does.
    expect(runScript(root, lib, 'build').ok).toBe(true);
    const result = tscBuild();
    expect(result.ok, result.output).toBe(true);
    expect(existsSync(join(root, lib, '.tsc/src/index.d.ts'))).toBe(true);
    expect(runScript(root, app, 'typecheck').ok).toBe(true);
  });

  it('negative control: with a noEmit library the app typecheck fails with TS6310, and so does check-tsrefs', () => {
    writeFileSync(
      join(root, lib, 'tsconfig.json'),
      '{ "extends": "@ralysa/tsconfig/react-lib.json", "include": ["src", "test", "*.config.ts"] }\n',
    );
    // Every workspace's `typecheck` is `tsc -p tsconfig.json`, which validates references.
    // (TypeScript 6's `tsc -b` tolerates a noEmit reference, so it is not the control here.)
    const result = runScript(root, app, 'typecheck');
    expect(result.ok).toBe(false);
    expect(result.output).toContain('TS6310');
    expect(refFindings()).toEqual(['tsrefs/reference-no-emit']);
  });
});
