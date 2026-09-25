// Loads an entry point's config from a YAML file, applies environment overrides, and validates it
// with that entry point's schema plus the cross-field checks (F-002 design §3.8). Validation
// messages name the field path and rule, never the value.
//
// Overrides: RALYSA_CFG__<PATH> with `__` between segments, e.g. RALYSA_CFG__DB__HOST=db.internal
// or RALYSA_CFG__LISTEN__PORT=8443. The value is parsed as JSON when it parses (numbers,
// booleans), else used as a string. Only scalar values are accepted: JSON objects, arrays and
// null are refused. Overrides can only set values the schema then validates, so a
// credential still can't be passed this way (every credential field is a vault path).
//
// Security-relevant settings can't be overridden (code review of #25): `env` (one source of truth
// for the environment, SEC-F002-12: an override to dev would switch off every production guard),
// vault.auth.* and vault.allow_approle (how the process authenticates), trust_proxy_cidrs (whose
// X-Forwarded-For is believed), idp.issuer, idp.require_mfa_claim and
// access.mfa_claim_exception_ref (who can sign in and how). Settings the production guards
// already check (vault.addr, db.ssl, public_base_url, graph_base_url) may be overridden; the
// guards still apply. The NAMES of applied overrides are reported at start, never the values.
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

/** Config paths (joined with `.`) that no override may set, or set under. */
export const PROTECTED_PATHS = [
  'env',
  'vault.auth',
  'vault.allow_approle',
  'trust_proxy_cidrs',
  'idp.issuer',
  'idp.require_mfa_claim',
  'access.mfa_claim_exception_ref',
] as const;

/**
 * A path is protected when it IS a protected path, lies UNDER one, or lies ABOVE one: overriding
 * `vault` or `idp` as a whole would replace the protected settings inside (re-review of #25).
 */
const isProtected = (path: string): boolean =>
  PROTECTED_PATHS.some((p) => path === p || path.startsWith(`${p}.`) || p.startsWith(`${path}.`));

/**
 * Applies RALYSA_CFG__A__B=value overrides onto a parsed YAML document (copy). `applied` receives
 * the dotted names of the overrides used (never values).
 */
export function applyEnvOverrides(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>>,
  applied: string[] = [],
): unknown {
  const root: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? structuredClone(raw as Record<string, unknown>) : {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(ENV_OVERRIDE_PREFIX) || value === undefined) continue;
    const path = name.slice(ENV_OVERRIDE_PREFIX.length).toLowerCase().split('__');
    if (path.some((segment) => !/^[a-z][a-z0-9_]*$/.test(segment))) {
      throw new ConfigError(`invalid override name ${name}`);
    }
    if (isProtected(path.join('.'))) {
      throw new ConfigError(`${name} can't be overridden: set it in the config file`);
    }
    applied.push(path.join('.'));
    let node = root;
    for (const segment of path.slice(0, -1)) {
      const next = node[segment];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) node[segment] = {};
      node = node[segment] as Record<string, unknown>;
    }
    // Scalars only (string, number, boolean): an object or array value could carry whole config
    // subtrees past the path checks (re-review of #25). A value that isn't JSON is a string.
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    if (
      parsed === null ||
      (typeof parsed !== 'string' && typeof parsed !== 'number' && typeof parsed !== 'boolean')
    ) {
      throw new ConfigError(
        `${name} must be a single value (string, number or boolean), not an object or array`,
      );
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

/** Reports applied override names at start (one JSON line; names only). */
export const reportOverridesToStdout = (names: readonly string[]): void => {
  if (names.length > 0) {
    process.stdout.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'config_overrides', names })}\n`,
    );
  }
};

export function loadConfigFile<S extends z.ZodType>(
  schema: S,
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  report: (names: readonly string[]) => void = reportOverridesToStdout,
): z.infer<S> {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(
      `cannot read config ${path}: ${(error as Error).message.split('\n')[0] ?? ''}`,
    );
  }
  const applied: string[] = [];
  const config = parseConfig(schema, applyEnvOverrides(raw, env, applied));
  report(applied);
  return config;
}
