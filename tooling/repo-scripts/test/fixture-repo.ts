// Builds throw-away repositories for the check tests. Nothing here touches the real repo.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeTempDir } from './temp.ts';

export interface FixtureWorkspace {
  dir: string;
  pkg: Record<string, unknown>;
  files?: Record<string, string>;
}

export function validWorkspacePackage(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: {
      lint: 'eslint .',
      typecheck: 'tsc -p tsconfig.json',
      test: 'vitest run',
      build: 'tsc -p tsconfig.build.json',
    },
    ralysa: { kind: 'service', shipped: true, ui: false, artefacts: ['dist'] },
    ...overrides,
  };
}

export const DEFAULT_WORKSPACE_YAML = `packages:
  - "apps/*"
  - "packages/*"
  - "services/*"
  - "tooling/*"
strictDepBuilds: true
allowBuilds: {}
`;

export interface FixtureRepo {
  root: string;
  write: (path: string, content: string) => void;
  writeJson: (path: string, value: unknown) => void;
}

export function makeFixtureRepo(
  options: {
    workspaces?: FixtureWorkspace[];
    rootPkg?: Record<string, unknown>;
    workspaceYaml?: string;
    lifecycleEntries?: unknown[];
    allowBuildsEntries?: unknown[];
    pnpmfileEntries?: unknown[];
  } = {},
): FixtureRepo {
  const root = makeTempDir('ralysa-fixture-');
  const write = (path: string, content: string): void => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const writeJson = (path: string, value: unknown): void => {
    write(path, `${JSON.stringify(value, null, 2)}\n`);
  };

  write('pnpm-workspace.yaml', options.workspaceYaml ?? DEFAULT_WORKSPACE_YAML);
  writeJson(
    'package.json',
    options.rootPkg ?? { name: 'ralysa', private: true, scripts: { build: 'turbo run build' } },
  );
  writeJson('tooling/repo-scripts/lifecycle-allowlist.json', {
    entries: options.lifecycleEntries ?? [],
  });
  writeJson('tooling/repo-scripts/allow-builds.json', {
    entries: options.allowBuildsEntries ?? [],
  });
  writeJson('tooling/repo-scripts/pnpmfile-allowlist.json', {
    entries: options.pnpmfileEntries ?? [],
  });
  writeJson('tooling/repo-scripts/package.json', {
    ...validWorkspacePackage('@ralysa/repo-scripts'),
    ralysa: { kind: 'tooling', shipped: false, ui: false, artefacts: [] },
  });
  for (const workspace of options.workspaces ?? []) {
    writeJson(`${workspace.dir}/package.json`, workspace.pkg);
    for (const [file, content] of Object.entries(workspace.files ?? {}))
      write(`${workspace.dir}/${file}`, content);
  }
  return { root, write, writeJson };
}
