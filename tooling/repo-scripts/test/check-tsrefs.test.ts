import { describe, expect, it } from 'vitest';
import { checkTsrefs } from '../src/check-tsrefs.ts';
import { makeFixtureRepo, validWorkspacePackage } from './fixture-repo.ts';

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
          files: { 'tsconfig.json': '{}' },
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
});
