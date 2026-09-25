// Loads an entry point's config from a YAML file and validates it with that entry point's schema
// (F-002 design §3.8). Validation messages name the field path and rule, never the value.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { z } from 'zod';

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(issues.length === 0 ? message : `${message}:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function parseConfig<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      'invalid config',
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return result.data;
}

export function loadConfigFile<S extends z.ZodType>(schema: S, path: string): z.infer<S> {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(
      `cannot read config ${path}: ${(error as Error).message.split('\n')[0] ?? ''}`,
    );
  }
  return parseConfig(schema, raw);
}
