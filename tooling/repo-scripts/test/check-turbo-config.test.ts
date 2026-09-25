// TC-F-001-45 (SEC-F001-12, -23).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_GLOBAL_DEPENDENCIES,
  checkTurboConfig,
  checkTurboConfigFile,
} from '../src/check-turbo-config.ts';
import { cleanEnv, copyRepo, REAL_ROOT } from './repo-copy.ts';

const valid = () => ({
  globalDependencies: [...REQUIRED_GLOBAL_DEPENDENCIES],
  remoteCache: { enabled: false },
  tasks: {
    build: { outputs: ['dist/**'] },
    'check:generated': { cache: false },
    'test:integration': { cache: false },
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
