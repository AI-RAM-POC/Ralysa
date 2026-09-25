// check-turbo-config (F-001 design §6.4; SEC-F001-12, -23): the Turbo remote cache stays off, the
// root and shared configs stay in globalDependencies (so a config change invalidates every cached
// gate), and no check or scan task can be replayed from the cache.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Finding, isRecord, listWorkspaceDirs, readJsonc } from './lib/repo.ts';

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

  findings.push(...checkTaskCaching(taskMap(config), {}, path));
  return findings;
}

function taskMap(config: unknown): Record<string, unknown> {
  return isRecord(config) && isRecord(config.tasks) ? config.tasks : {};
}

function taskName(id: string): string {
  return id.includes('#') ? id.slice(id.indexOf('#') + 1) : id;
}

function mustNotCache(name: string): boolean {
  return /^(check|scan)/.test(name) || (UNCACHED_TASKS as readonly string[]).includes(name);
}

/**
 * Checks that every check/scan/uncached task resolves to `cache: false`. For a package-level
 * turbo.json, a task that doesn't set `cache` inherits the root definition's value, so `inherited`
 * holds the root tasks (empty when checking the root itself).
 */
function checkTaskCaching(
  tasks: Record<string, unknown>,
  inherited: Record<string, unknown>,
  path: string,
): Finding[] {
  const findings: Finding[] = [];
  for (const [id, definition] of Object.entries(tasks)) {
    const name = taskName(id);
    if (!mustNotCache(name)) continue;
    const own = isRecord(definition) ? definition.cache : undefined;
    const parent = inherited[name];
    const effective = own ?? (isRecord(parent) ? parent.cache : undefined) ?? true;
    if (effective !== false) {
      findings.push({
        rule: 'turbo/cached-check',
        path,
        message: `task "${id}" must resolve to "cache": false so a replay can never stand in for the check`,
      });
    }
  }
  return findings;
}

/**
 * Package-level turbo.json files (`<workspace>/turbo.json` with `extends: ["//"]`) can override a
 * root task, so they get the same caching rule (code review m2). They also may not carry
 * root-only keys.
 */
export function checkPackageTurboConfig(
  config: unknown,
  rootConfig: unknown,
  path: string,
): Finding[] {
  if (!isRecord(config))
    return [{ rule: 'turbo/shape', path, message: 'turbo.json is not an object' }];
  const findings = checkTaskCaching(taskMap(config), taskMap(rootConfig), path);
  for (const key of ['remoteCache', 'globalDependencies', 'globalEnv', 'globalPassThroughEnv']) {
    if (key in config) {
      findings.push({
        rule: 'turbo/package-root-key',
        path,
        message: `"${key}" belongs only in the root turbo.json`,
      });
    }
  }
  return findings;
}

export function checkTurboConfigFile(root: string): Finding[] {
  const rootConfig = readJsonc(join(root, 'turbo.json'));
  const findings = checkTurboConfig(rootConfig);
  for (const dir of listWorkspaceDirs(root)) {
    const file = join(root, dir, 'turbo.json');
    if (!existsSync(file)) continue;
    findings.push(...checkPackageTurboConfig(readJsonc(file), rootConfig, `${dir}/turbo.json`));
  }
  return findings;
}
