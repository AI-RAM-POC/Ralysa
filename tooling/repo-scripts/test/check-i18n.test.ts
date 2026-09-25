// TC-F-001-12 (AC-6), check-i18n part: 0 missing en/ar keys; key parity, Arabic plural
// completeness, grammar, empty values, interpolation parity, the native-review register (OQ-D8),
// the untranslated warning, and the workspace wiring (extract --ci in lint, types in
// check:generated). Also runs on the real repo.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CatalogInput,
  checkCatalogs,
  checkI18n,
  NEEDS_REVIEW,
  pluralCategories,
} from '../src/check-i18n.ts';
import { findRepoRoot } from '../src/lib/core.ts';
import { makeTempDir } from './temp.ts';

const rules = (input: CatalogInput): string[] => checkCatalogs(input).findings.map((f) => f.rule);

const review = (keys: string[]): unknown => ({
  ar: Object.fromEntries(keys.map((key) => [key, NEEDS_REVIEW])),
});

const ok = (): CatalogInput => ({
  dir: 'packages/x/src/locales',
  locales: {
    en: {
      x: {
        app: { name: 'Ralysa', greet: 'Hello {{name}}' },
        item: { count_one: '{{count}} item', count_other: '{{count}} items' },
      },
    },
    ar: {
      x: {
        app: { name: 'راليسا', greet: 'مرحبا {{name}}' },
        item: Object.fromEntries(
          pluralCategories('ar').map((c) => [`count_${c}`, `{{count}} عنصر`]),
        ),
      },
    },
  },
  review: review([
    'x:app.greet',
    'x:app.name',
    ...pluralCategories('ar').map((c) => `x:item.count_${c}`),
  ]),
});

describe('checkCatalogs', () => {
  it('passes a complete catalog pair', () => {
    const result = checkCatalogs(ok());
    expect(result.findings).toEqual([]);
    expect(result.needsReview).toEqual({ 'packages/x/src/locales': 8 });
  });

  it('knows the CLDR plural categories', () => {
    expect(pluralCategories('en')).toEqual(['one', 'other']);
    expect(pluralCategories('ar').sort()).toEqual(['few', 'many', 'one', 'other', 'two', 'zero']);
  });

  it('reports a key missing from ar (0 missing keys otherwise)', () => {
    const input = ok();
    delete (input.locales.ar?.x as { app: Record<string, string> }).app.greet;
    expect(rules(input)).toContain('i18n/missing-key');
  });

  it('reports a key missing from en that ar has', () => {
    const input = ok();
    (input.locales.ar?.x as { app: Record<string, string> }).app.extra = 'زائد';
    expect(rules(input)).toContain('i18n/extra-key');
  });

  it('requires all six Arabic plural forms', () => {
    const input = ok();
    delete (input.locales.ar?.x as { item: Record<string, string> }).item.count_few;
    const found = checkCatalogs(input).findings;
    expect(found.map((f) => f.message)).toContain('"item.count_few" is missing');
  });

  it('enforces the key grammar (2–5 lowerCamel segments)', () => {
    for (const bad of [
      { Title: 'x' },
      { single: 'x' },
      { a: { b_c: 'x' } },
      { a: { b: { c: { d: { e: { f: 'x' } } } } } },
    ]) {
      const input: CatalogInput = {
        dir: 'd',
        locales: { en: { x: bad }, ar: { x: bad } },
        review: undefined,
      };
      expect(rules(input), JSON.stringify(bad)).toContain('i18n/key-grammar');
    }
  });

  it('rejects empty and non-string values', () => {
    const input = ok();
    (input.locales.ar?.x as { app: Record<string, unknown> }).app.name = ' ';
    (input.locales.en?.x as { app: Record<string, unknown> }).app.list = ['a'];
    expect(rules(input)).toEqual(expect.arrayContaining(['i18n/empty', 'i18n/value']));
  });

  it('requires the same interpolation names', () => {
    const input = ok();
    (input.locales.ar?.x as { app: Record<string, string> }).app.greet = 'مرحبا {{user}}';
    expect(rules(input)).toContain('i18n/interpolation');
  });

  it('requires both locales and every namespace in each', () => {
    expect(
      rules({ dir: 'd', locales: { en: { x: { a: { b: 'c' } } } }, review: undefined }),
    ).toContain('i18n/locales');
    const input = ok();
    (input.locales.en as Record<string, unknown>).y = { a: { b: 'c' } };
    expect(rules(input)).toContain('i18n/missing-namespace');
  });

  it('requires a review entry for every ar string, and none for keys that do not exist', () => {
    const missing = ok();
    missing.review = review(['x:app.name']);
    expect(rules(missing)).toContain('i18n/review-missing');
    const stale = ok();
    (stale.review as { ar: Record<string, string> }).ar['x:app.gone'] = NEEDS_REVIEW;
    expect(rules(stale)).toContain('i18n/review-stale');
    const none = ok();
    none.review = undefined;
    expect(rules(none)).toContain('i18n/review-file');
  });

  it('accepts a reviewed entry and rejects an unknown status', () => {
    const input = ok();
    const entries = (input.review as { ar: Record<string, unknown> }).ar;
    entries['x:app.name'] = { reviewer: 'Native Reviewer', date: '2026-10-01' };
    expect(checkCatalogs(input).findings).toEqual([]);
    expect(checkCatalogs(input).needsReview).toEqual({ 'packages/x/src/locales': 7 });
    entries['x:app.greet'] = 'looks fine';
    expect(rules(input)).toContain('i18n/review-status');
  });

  it('warns (without failing) when an ar value equals the en value and has Latin letters', () => {
    const input = ok();
    (input.locales.ar?.x as { app: Record<string, string> }).app.name = 'Ralysa';
    const result = checkCatalogs(input);
    expect(result.findings).toEqual([]);
    expect(result.warnings.map((w) => w.rule)).toEqual(['i18n/untranslated']);
  });
});

describe('checkI18n (workspace scan)', () => {
  function workspace(root: string, scripts: Record<string, string>, withConfig = true): void {
    const dir = join(root, 'packages/x');
    const write = (file: string, content: unknown): void => {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(
        join(dir, file),
        typeof content === 'string' ? content : JSON.stringify(content),
      );
    };
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    write('package.json', {
      name: '@ralysa/x',
      scripts,
      ralysa: { kind: 'library', ui: true, shipped: false },
    });
    if (withConfig) write('i18next.config.ts', 'export default {};\n');
    write('src/locales/en/x.json', { app: { name: 'Ralysa' } });
    write('src/locales/ar/x.json', { app: { name: 'راليسا' } });
    write('src/locales/review.json', { ar: { 'x:app.name': NEEDS_REVIEW } });
  }
  const wired = {
    lint: 'eslint . && i18next-cli extract --ci --dry-run --quiet',
    'check:generated': 'i18next-cli types --quiet',
  };

  it('passes a wired workspace', () => {
    const root = makeTempDir('ralysa-fixture-');
    workspace(root, wired);
    expect(checkI18n({ root }).findings).toEqual([]);
  });

  it('fails when extract --ci or types is not wired, or the config is missing', () => {
    const root = makeTempDir('ralysa-fixture-');
    workspace(root, { lint: 'eslint .', 'check:generated': 'true' }, false);
    expect(
      checkI18n({ root })
        .findings.map((f) => f.rule)
        .sort(),
    ).toEqual(['i18n/config', 'i18n/extract-not-wired', 'i18n/types-not-wired']);
  });

  it('passes on the real repository', () => {
    const report = checkI18n({ root: findRepoRoot() });
    expect(report.findings).toEqual([]);
    expect(Object.keys(report.needsReview).length).toBeGreaterThan(0);
  });
});
