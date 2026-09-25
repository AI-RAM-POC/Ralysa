// The one JSON Schema generator (F-002 design §3.5, §3.10): the committed files equal the
// generator's output (a hermetic drift check next to CI's `check:generated`), the contracts have
// no construct without a JSON Schema form, and no generated contract has a password-like field.
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { SCHEMA_REGISTRY, generateSchemas, toJsonSchema } from '../src/schema/generator.js';

declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options: { eager: true; import: 'default' }): Record<string, T>;
  }
}

// Vite resolves this literal pattern at build time; no dynamic import (SEC-F001-09 b).
const committed = import.meta.glob<unknown>('../src/schema/generated/*.json', {
  eager: true,
  import: 'default',
});
const committedByName = new Map(
  Object.entries(committed).map(([path, value]) => [path.split('/').at(-1) ?? path, value]),
);

describe('JSON Schema generation', () => {
  const generated = generateSchemas();

  it('the committed files are exactly the registry (run check:generated after a change)', () => {
    expect([...committedByName.keys()].sort()).toEqual([...generated.keys()].sort());
  });

  it.each(SCHEMA_REGISTRY.map((entry) => entry.file))('%s matches the generator output', (file) => {
    expect(committedByName.get(file)).toEqual(JSON.parse(generated.get(file) ?? 'null'));
  });

  it('every schema has a stable URN $id and the 2020-12 dialect', () => {
    for (const [file, text] of generated) {
      const schema = JSON.parse(text) as Record<string, unknown>;
      expect(schema.$id).toBe(`urn:ralysa:schema:${file.replace(/\.json$/, '')}`);
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    }
  });

  it('refuses a contract with a transform: the schema must be the wire shape', () => {
    const withTransform = z.strictObject({ n: z.string().transform((s) => s.length) });
    expect(() =>
      toJsonSchema({ file: 'x.v1.json', title: 'X', schema: withTransform, io: 'output' }),
    ).toThrow();
  });

  it('AC-3: no generated contract has a password, PIN, OTP or client_secret field', () => {
    const banned = /pass(word|wd|phrase)|\bpin\b|otp|client_secret/i;
    const names = (node: unknown): string[] => {
      if (Array.isArray(node)) return node.flatMap(names);
      if (typeof node !== 'object' || node === null) return [];
      const record = node as Record<string, unknown>;
      const own =
        typeof record.properties === 'object' && record.properties !== null
          ? Object.keys(record.properties)
          : [];
      return [...own, ...Object.values(record).flatMap(names)];
    };
    for (const [file, text] of generated) {
      expect({ file, hits: names(JSON.parse(text)).filter((n) => banned.test(n)) }).toEqual({
        file,
        hits: [],
      });
    }
  });

  it('the audit envelope schema lists endpoint_region and inference_region (BC-04)', () => {
    const audit = JSON.parse(generated.get('audit-event.v1.json') ?? '{}') as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(audit.properties)).toEqual(
      expect.arrayContaining(['endpoint_region', 'inference_region', 'schema_version', 'ts']),
    );
    expect(audit.required).toEqual(
      expect.arrayContaining([
        'event_id',
        'action',
        'actor',
        'outcome',
        'trace_id',
        'details',
        'ts',
        'org_id',
        'source',
        'attestation',
      ]),
    );
  });
});
