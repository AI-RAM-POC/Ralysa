// TC-F-001-45 (SEC-F001-12, -23).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_GLOBAL_DEPENDENCIES,
  TYPECHECK_DEPENDS_ON,
  TYPECHECK_OUTPUT,
  checkTurboConfig,
  checkTurboConfigFile,
} from '../src/check-turbo-config.ts';
import { makeFixtureRepo, validWorkspacePackage } from './fixture-repo.ts';
import { cleanEnv, copyRepo, REAL_ROOT } from './repo-copy.ts';

const valid = () => ({
  globalDependencies: [...REQUIRED_GLOBAL_DEPENDENCIES],
  remoteCache: { enabled: false },
  tasks: {
    build: { outputs: ['dist/**'] },
    typecheck: { dependsOn: ['^build', TYPECHECK_DEPENDS_ON], outputs: [TYPECHECK_OUTPUT] },
    'check:generated': { cache: false },
    'test:integration': { cache: false, passThroughEnv: ['RALYSA_REQUIRE_DEV_STACK'] },
  },
});

const rules = (config: unknown) => checkTurboConfig(config).map((f) => f.rule);

describe('check-turbo-config', () => {
  it('passes the real turbo.json', () => {
    expect(checkTurboConfigFile(REAL_ROOT)).toEqual([]);
  });

  it('passes a valid config', () => {
    expect(rules(valid())).toEqual([]);
  });

  it.each([{ remoteCache: { enabled: true } }, { remoteCache: {} }, { remoteCache: undefined }])(
    'fails when the remote cache is not explicitly disabled: %o',
    (override) => {
      expect(rules({ ...valid(), ...override })).toContain('turbo/remote-cache');
    },
  );

  it.each([...REQUIRED_GLOBAL_DEPENDENCIES])('fails when globalDependencies lacks %s', (entry) => {
    const config = valid();
    config.globalDependencies = config.globalDependencies.filter((e) => e !== entry);
    expect(rules(config)).toContain('turbo/global-dependencies');
  });

  it.each([
    ['without ^typecheck', { dependsOn: ['^build'], outputs: [TYPECHECK_OUTPUT] }],
    ['without the .tsc/ output', { dependsOn: ['^build', TYPECHECK_DEPENDS_ON] }],
    ['missing', undefined],
  ])('fails when the typecheck task is %s (TS6305 in a clean checkout)', (_, typecheck) => {
    const config = valid();
    (config.tasks as Record<string, unknown>).typecheck = typecheck;
    expect(rules(config)).toContain('turbo/typecheck-order');
  });

  it.each([
    'check:generated',
    'check-i18n',
    'scan:secrets',
    '@ralysa/ui#check:contrast',
    'test:integration',
  ])('fails when %s is cacheable', (task) => {
    const config = valid();
    (config.tasks as Record<string, object>)[task] = {};
    expect(rules(config)).toContain('turbo/cached-check');
  });
});

describe('test:integration env (F-002-T05)', () => {
  it.each([{ cache: false }, { cache: false, passThroughEnv: ['OTHER'] }])(
    'fails when RALYSA_REQUIRE_DEV_STACK is not passed through: %o',
    (task) => {
      const config = valid();
      (config.tasks as Record<string, object>)['test:integration'] = task;
      expect(rules(config)).toContain('turbo/integration-require-env');
    },
  );
});

describe('globalDependencies invalidate every lint hash (TC-F-001-45, SEC-F001-23)', () => {
  const turbo = join(REAL_ROOT, 'node_modules', '.bin', 'turbo');

  function lintHashes(root: string): Map<string, string> {
    const out = execFileSync(turbo, ['run', 'lint', '--dry=json', `--cwd=${root}`], {
      encoding: 'utf8',
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const run = JSON.parse(out) as { tasks: { taskId: string; task: string; hash: string }[] };
    return new Map(run.tasks.filter((t) => t.task === 'lint').map((t) => [t.taskId, t.hash]));
  }

  it('changing .dependency-cruiser.cjs or a tooling config changes every lint task hash', () => {
    const root = copyRepo();
    const before = lintHashes(root);
    expect(before.size).toBeGreaterThan(10);

    writeFileSync(join(root, '.dependency-cruiser.cjs'), 'module.exports = { forbidden: [] };\n');
    const afterCruiser = lintHashes(root);

    const base = join(root, 'tooling', 'eslint-config', 'base.js');
    writeFileSync(base, `${readFileSync(base, 'utf8')}\n// probe\n`);
    const afterTooling = lintHashes(root);

    for (const [task, hash] of before) {
      expect(afterCruiser.get(task), task).not.toBe(hash);
      expect(afterTooling.get(task), task).not.toBe(afterCruiser.get(task));
    }
  });
});

describe('check-turbo-config: package-level turbo.json (code review m2)', () => {
  function repoWith(packageTurbo: unknown) {
    const fixture = makeFixtureRepo({
      workspaces: [{ dir: 'packages/ui', pkg: validWorkspacePackage('@ralysa/ui') }],
    });
    fixture.writeJson('turbo.json', valid());
    fixture.writeJson('packages/ui/turbo.json', packageTurbo);
    return fixture.root;
  }

  it('fails when a package sets check:generated to cache: true', () => {
    const root = repoWith({ extends: ['//'], tasks: { 'check:generated': { cache: true } } });
    expect(checkTurboConfigFile(root)).toContainEqual(
      expect.objectContaining({ rule: 'turbo/cached-check', path: 'packages/ui/turbo.json' }),
    );
  });

  it('fails when a package makes test:integration cacheable (F-002-T02, SEC-F002-28)', () => {
    // A cache hit would replay a green run and skip the TC-F-002-14/-20 scans.
    const root = repoWith({ extends: ['//'], tasks: { 'test:integration': { cache: true } } });
    expect(checkTurboConfigFile(root)).toContainEqual(
      expect.objectContaining({ rule: 'turbo/cached-check', path: 'packages/ui/turbo.json' }),
    );
  });

  it('fails when a package defines a new check task without cache: false', () => {
    const root = repoWith({ extends: ['//'], tasks: { 'check:contrast': { outputs: [] } } });
    expect(checkTurboConfigFile(root).map((f) => f.rule)).toContain('turbo/cached-check');
  });

  it('passes a package override that inherits the root cache: false', () => {
    const root = repoWith({
      extends: ['//'],
      tasks: { 'check:generated': { inputs: ['tokens/**'] } },
    });
    expect(checkTurboConfigFile(root)).toEqual([]);
  });

  it('fails when a package turbo.json carries a root-only key', () => {
    const root = repoWith({ extends: ['//'], remoteCache: { enabled: true } });
    expect(checkTurboConfigFile(root).map((f) => f.rule)).toContain('turbo/package-root-key');
  });
});
