import { describe, expect, it } from 'vitest';
import { checkTsrefs } from '../src/check-tsrefs.ts';
import { makeFixtureRepo, validWorkspacePackage } from './fixture-repo.ts';

// The library-template convention: declaration-only emit into .tsc/ (T08-8).
const REFERENCEABLE = JSON.stringify({
  compilerOptions: {
    composite: true,
    noEmit: false,
    emitDeclarationOnly: true,
    outDir: '${configDir}/.tsc',
  },
});

const library = (name: string) =>
  validWorkspacePackage(name, {
    ralysa: { kind: 'library', runtime: 'isomorphic', shipped: false, ui: false },
  });

describe('check-tsrefs', () => {
  it('passes when the root references every TS workspace and dependents reference their libraries', () => {
    const fixture = makeFixtureRepo({
      workspaces: [
        {
          dir: 'packages/protocol',
          pkg: library('@ralysa/protocol'),
          files: { 'tsconfig.json': REFERENCEABLE },
        },
        {
          dir: 'services/agent-host',
          pkg: validWorkspacePackage('@ralysa/agent-host', {
            dependencies: { '@ralysa/protocol': 'workspace:*' },
          }),
          files: { 'tsconfig.json': '{ "references": [{ "path": "../../packages/protocol" }] }' },
        },
      ],
    });
    fixture.write(
      'tsconfig.json',
      '{\n  // solution file\n  "files": [],\n  "references": [{ "path": "packages/protocol" }, { "path": "services/agent-host" },],\n}\n',
    );
    expect(checkTsrefs({ root: fixture.root })).toEqual([]);
  });

  it('reports a missing root reference, a stale one and a missing dependency reference', () => {
    const fixture = makeFixtureRepo({
      workspaces: [
        {
          dir: 'packages/protocol',
          pkg: library('@ralysa/protocol'),
          files: { 'tsconfig.json': '{}' },
        },
        {
          dir: 'services/agent-host',
          pkg: validWorkspacePackage('@ralysa/agent-host', {
            dependencies: { '@ralysa/protocol': 'workspace:*' },
          }),
          files: { 'tsconfig.json': '{}' },
        },
      ],
    });
    fixture.write(
      'tsconfig.json',
      '{ "files": [], "references": [{ "path": "packages/protocol" }, { "path": "apps/gone" }] }',
    );
    const rules = checkTsrefs({ root: fixture.root }).map((f) => f.rule);
    expect(rules).toEqual(
      expect.arrayContaining([
        'tsrefs/root-missing-reference',
        'tsrefs/root-stale-reference',
        'tsrefs/missing-reference',
      ]),
    );
  });

  describe('referenced projects must be referenceable (TS6306, TS6310)', () => {
    function repoWithLibraryConfig(libraryConfig: string, extraFiles: Record<string, string> = {}) {
      const fixture = makeFixtureRepo({
        workspaces: [
          {
            dir: 'packages/protocol',
            pkg: library('@ralysa/protocol'),
            files: { 'tsconfig.json': libraryConfig, ...extraFiles },
          },
          {
            dir: 'apps/web',
            pkg: validWorkspacePackage('@ralysa/web', {
              dependencies: { '@ralysa/protocol': 'workspace:*' },
            }),
            // An app is a leaf: nothing references it, so its own noEmit is fine.
            files: {
              'tsconfig.json':
                '{ "compilerOptions": { "composite": true, "noEmit": true }, "references": [{ "path": "../../packages/protocol" }] }',
            },
          },
        ],
      });
      fixture.write(
        'tsconfig.json',
        '{ "files": [], "references": [{ "path": "apps/web" }, { "path": "packages/protocol" }] }',
      );
      return checkTsrefs({ root: fixture.root });
    }

    it('passes the declaration-only library convention', () => {
      expect(repoWithLibraryConfig(REFERENCEABLE)).toEqual([]);
    });

    it('passes when the convention comes through extends', () => {
      expect(
        repoWithLibraryConfig('{ "extends": "./base.json" }', { 'base.json': REFERENCEABLE }),
      ).toEqual([]);
    });

    it('fails a referenced project with noEmit (the TS6310 precondition)', () => {
      const findings = repoWithLibraryConfig(
        '{ "compilerOptions": { "composite": true, "noEmit": true } }',
      );
      expect(findings.map((f) => [f.rule, f.path])).toEqual([
        ['tsrefs/reference-no-emit', 'packages/protocol/tsconfig.json'],
      ]);
      expect(findings[0]?.message).toMatch(/emitDeclarationOnly/);
    });

    it('fails noEmit inherited through extends', () => {
      const findings = repoWithLibraryConfig('{ "extends": "./base.json" }', {
        'base.json': '{ "compilerOptions": { "composite": true, "noEmit": true } }',
      });
      expect(findings.map((f) => f.rule)).toEqual(['tsrefs/reference-no-emit']);
    });

    it('fails a referenced project that is not composite (TS6306)', () => {
      const findings = repoWithLibraryConfig(
        '{ "compilerOptions": { "emitDeclarationOnly": true, "declaration": true } }',
      );
      expect(findings.map((f) => f.rule)).toEqual(['tsrefs/reference-not-composite']);
    });

    it('reports a referenced config whose extends cannot be resolved', () => {
      const findings = repoWithLibraryConfig('{ "extends": "./missing.json" }');
      expect(findings.map((f) => f.rule)).toEqual(['tsrefs/unreadable-reference']);
    });
  });
});
