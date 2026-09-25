// check-turbo-config (F-001 design §6.4; SEC-F001-12, -23): the Turbo remote cache stays off, the
// root and shared configs stay in globalDependencies (so a config change invalidates every cached
// gate), and no check or scan task can be replayed from the cache.
import { join } from 'node:path';
import { type Finding, isRecord, readJsonc } from './lib/repo.ts';

export const REQUIRED_GLOBAL_DEPENDENCIES = [
  '.dependency-cruiser.cjs',
  'tsconfig.json',
  'prettier.config.js',
  '.prettierignore',
  '.nvmrc',
  'pnpm-workspace.yaml',
  'tooling/**/*',
  '!tooling/**/node_modules/**',
] as const;

/** Tasks that must never be cached, whatever their name. */
export const UNCACHED_TASKS = ['check:generated', 'test:integration'] as const;

export function checkTurboConfig(config: unknown, path = 'turbo.json'): Finding[] {
  const findings: Finding[] = [];
  if (!isRecord(config))
    return [{ rule: 'turbo/shape', path, message: 'turbo.json is not an object' }];

  const remote = config.remoteCache;
  if (!isRecord(remote) || remote.enabled !== false) {
    findings.push({
      rule: 'turbo/remote-cache',
      path,
      message: 'remoteCache.enabled must be false: build outputs must not leave CI (SEC-F001-12)',
    });
  }

  const globals = Array.isArray(config.globalDependencies) ? config.globalDependencies : [];
  for (const entry of REQUIRED_GLOBAL_DEPENDENCIES) {
    if (!globals.includes(entry)) {
      findings.push({
        rule: 'turbo/global-dependencies',
        path,
        message: `globalDependencies must include "${entry}" so a change to it invalidates every cached task (SEC-F001-23)`,
      });
    }
  }

  const tasks = isRecord(config.tasks) ? config.tasks : {};
  for (const [id, definition] of Object.entries(tasks)) {
    const name = id.includes('#') ? id.slice(id.indexOf('#') + 1) : id;
    const mustNotCache =
      /^(check|scan)/.test(name) || (UNCACHED_TASKS as readonly string[]).includes(name);
    if (mustNotCache && (!isRecord(definition) || definition.cache !== false)) {
      findings.push({
        rule: 'turbo/cached-check',
        path,
        message: `task "${id}" must set "cache": false so a replay can never stand in for the check`,
      });
    }
  }
  return findings;
}

export function checkTurboConfigFile(root: string): Finding[] {
  return checkTurboConfig(readJsonc(join(root, 'turbo.json')));
}
