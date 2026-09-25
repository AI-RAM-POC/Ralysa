import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listWorkspaceDirs, readJson } from '../src/lib/repo.ts';
import { placeholderGuard } from '../src/placeholder-guard.ts';
import { makeFixtureRepo, validWorkspacePackage } from './fixture-repo.ts';
import { REAL_ROOT } from './repo-copy.ts';

const placeholder = (name: string) =>
  validWorkspacePackage(name, {
    ralysa: { kind: 'placeholder', shipped: false, ui: false, artefacts: [] },
  });

describe('placeholder-guard (design §2.1)', () => {
  it('passes a folder with only README.md and package.json', () => {
    const fixture = makeFixtureRepo({
      workspaces: [
        {
          dir: 'services/demo',
          pkg: placeholder('@ralysa/demo'),
          files: { 'README.md': '# demo\n' },
        },
      ],
    });
    const findings = placeholderGuard({
      dir: join(fixture.root, 'services/demo'),
      root: fixture.root,
      repoFiles: ['services/demo/README.md', 'services/demo/package.json'],
    });
    expect(findings).toEqual([]);
  });

  it('fails as soon as any other file appears, and names the scaffold command', () => {
    const fixture = makeFixtureRepo({
      workspaces: [{ dir: 'services/demo', pkg: placeholder('@ralysa/demo') }],
    });
    const findings = placeholderGuard({
      dir: join(fixture.root, 'services/demo'),
      root: fixture.root,
      repoFiles: ['services/demo/package.json', 'services/demo/src/index.ts'],
    });
    expect(findings).toEqual([
      expect.objectContaining({
        rule: 'placeholder/has-code',
        path: 'services/demo/src/index.ts',
        message: expect.stringContaining('pnpm scaffold services/demo --kind') as string,
      }),
    ]);
  });

  it('refuses to run in a package that is not a placeholder', () => {
    const fixture = makeFixtureRepo({
      workspaces: [{ dir: 'services/demo', pkg: validWorkspacePackage('@ralysa/demo') }],
    });
    const findings = placeholderGuard({
      dir: join(fixture.root, 'services/demo'),
      root: fixture.root,
      repoFiles: [],
    });
    expect(findings.map((f) => f.rule)).toEqual(['placeholder/wrong-kind']);
  });

  it('every placeholder in the real repo passes', () => {
    const placeholders = listWorkspaceDirs(REAL_ROOT).filter((dir) => {
      const pkg = readJson(join(REAL_ROOT, dir, 'package.json')) as { ralysa?: { kind?: string } };
      return pkg.ralysa?.kind === 'placeholder';
    });
    expect(placeholders.length).toBeGreaterThan(0);
    for (const dir of placeholders) {
      expect(placeholderGuard({ dir: join(REAL_ROOT, dir), root: REAL_ROOT }), dir).toEqual([]);
    }
  });
});
