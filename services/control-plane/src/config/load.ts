// Loads an entry point's config from a YAML file, applies environment overrides, and validates it
// with that entry point's schema plus the cross-field checks (F-002 design §3.8). Validation
// messages name the field path and rule, never the value.
//
// Overrides: RALYSA_CFG__<PATH> with `__` between segments, e.g. RALYSA_CFG__DB__HOST=db.internal
// or RALYSA_CFG__LISTEN__PORT=8443. The value is parsed as JSON when it parses (numbers,
// booleans), else used as a string. Overrides can only set values the schema then validates, so a
// credential still can't be passed this way (every credential field is a vault path).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { z } from 'zod';
import { type CommonConfig, crossFieldIssues } from './schema.js';

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(issues.length === 0 ? message : `${message}:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export const ENV_OVERRIDE_PREFIX = 'RALYSA_CFG__';

/** Applies RALYSA_CFG__A__B=value overrides onto a parsed YAML document (copy). */
export function applyEnvOverrides(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>>,
): unknown {
  const root: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? structuredClone(raw as Record<string, unknown>) : {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(ENV_OVERRIDE_PREFIX) || value === undefined) continue;
    const path = name.slice(ENV_OVERRIDE_PREFIX.length).toLowerCase().split('__');
    if (path.some((segment) => !/^[a-z][a-z0-9_]*$/.test(segment))) {
      throw new ConfigError(`invalid override name ${name}`);
    }
    let node = root;
    for (const segment of path.slice(0, -1)) {
      const next = node[segment];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) node[segment] = {};
      node = node[segment] as Record<string, unknown>;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    node[path.at(-1) ?? ''] = parsed;
  }
  return root;
}

export function parseConfig<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      'invalid config',
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const issues = crossFieldIssues(result.data as CommonConfig);
  if (issues.length > 0) throw new ConfigError('invalid config', issues);
  return result.data;
}

export function loadConfigFile<S extends z.ZodType>(
  schema: S,
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): z.infer<S> {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(
      `cannot read config ${path}: ${(error as Error).message.split('\n')[0] ?? ''}`,
    );
  }
  return parseConfig(schema, applyEnvOverrides(raw, env));
}
