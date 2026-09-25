// TC-F-001-06 (AC-3): the token source validates against the §3.2 contract; the 7 categories exist
// in both themes; light and dark semantic key sets are identical; aliases resolve. Also the
// generator's outputs: CSS variables per theme, the Tailwind namespace resets, and the committed
// generated.ts matching the source (drift, §3.5).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildTokens,
  cssVarName,
  flattenTokens,
  loadTokenSet,
  renderGeneratedTs,
  TOKEN_FILES,
  TokenError,
  type TokenSet,
  tailwindVarName,
  validateTokenSet,
} from '../scripts/build-tokens.ts';
import { Categories, CATEGORY_ROOTS } from '../src/contracts/tokens.ts';
import { buildTailwind } from './tailwind.ts';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const tokensDir = join(packageDir, 'tokens');

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof TokenError) return error.problems;
    throw error;
  }
  return [];
}

describe('token source (the real files)', () => {
  const set = loadTokenSet(tokensDir);
  const resolved = validateTokenSet(set);

  it('validates and resolves every alias in both themes', () => {
    expect(resolved.light.size).toBeGreaterThan(50);
    expect(resolved.dark.size).toBe(resolved.light.size);
  });

  it.each(Categories)('defines %s tokens in light and dark (AC-3)', (category) => {
    for (const theme of ['light', 'dark'] as const) {
      const root = CATEGORY_ROOTS[category];
      expect([...resolved[theme].keys()].some((path) => path.startsWith(`${root}.`))).toBe(true);
    }
  });

  it('has identical semantic key sets in light and dark', () => {
    const keys = (theme: 'light' | 'dark'): string[] =>
      set.themes[theme].map((def) => def.path).sort();
    expect(keys('dark')).toEqual(keys('light'));
  });

  it('matches the §7.1.3 placeholder values', () => {
    const hex = (theme: 'light' | 'dark', path: string): string =>
      (resolved[theme].get(path)?.value as { hex: string }).hex;
    expect(hex('light', 'color.fg.default')).toBe('#1a1d21');
    expect(hex('dark', 'color.fg.default')).toBe('#e7eaee');
    expect(hex('light', 'color.border.control')).toBe('#737b86');
    expect(hex('dark', 'color.focus.ring')).toBe('#8aaeff');
    expect(hex('dark', 'color.link')).toBe('#9dbbff');
  });

  it('keeps colour values out of the semantic files (aliases only)', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const def of set.themes[theme].filter((d) => d.type === 'color')) {
        expect(def.value, def.path).toMatch(/^\{palette\./);
      }
    }
  });
});

describe('token validation failures', () => {
  const core = flattenTokens(
    JSON.parse(readFileSync(join(tokensDir, TOKEN_FILES.core), 'utf8')) as unknown,
    TOKEN_FILES.core,
  );
  const theme = (doc: unknown, name: string): TokenSet['themes']['light'] =>
    flattenTokens(doc, name);
  const semantic = (value: unknown): unknown => ({
    color: { $type: 'color', fg: { default: { $value: value } } },
  });
  const setOf = (light: unknown, dark: unknown): TokenSet => ({
    core,
    themes: { light: theme(light, 'light.json'), dark: theme(dark, 'dark.json') },
  });

  it('rejects different key sets in light and dark', () => {
    const light = { color: { $type: 'color', fg: { a: { $value: '{palette.gray.0}' } } } };
    const dark = { color: { $type: 'color', fg: { b: { $value: '{palette.gray.0}' } } } };
    expect(problems(() => validateTokenSet(setOf(light, dark)))).toEqual([
      'color.fg.a is in the light theme but not in dark',
      'color.fg.b is in dark but not in the light theme',
    ]);
  });

  it('rejects an alias that does not resolve', () => {
    const doc = semantic('{palette.gray.7}');
    expect(problems(() => validateTokenSet(setOf(doc, doc))).join('\n')).toMatch(
      /alias \{palette\.gray\.7\} does not resolve/,
    );
  });

  it('rejects an alias to a token of another type', () => {
    const doc = semantic('{space.4}');
    expect(problems(() => validateTokenSet(setOf(doc, doc))).join('\n')).toMatch(
      /is a dimension, expected color/,
    );
  });

  it('rejects an alias cycle', () => {
    const doc = {
      color: {
        $type: 'color',
        fg: { a: { $value: '{color.fg.b}' }, b: { $value: '{color.fg.a}' } },
      },
    };
    expect(problems(() => validateTokenSet(setOf(doc, doc))).join('\n')).toMatch(/alias cycle/);
  });

  it('rejects a hex that disagrees with its components', () => {
    const doc = semantic({ colorSpace: 'srgb', components: [1, 1, 1], hex: '#000000' });
    expect(problems(() => validateTokenSet(setOf(doc, doc))).join('\n')).toMatch(
      /hex does not match components/,
    );
  });

  it('rejects a token without a $type', () => {
    expect(problems(() => flattenTokens({ x: { y: { $value: 1 } } }, 'f.json'))).toEqual([
      'f.json: x.y: no $type on the token or an enclosing group',
    ]);
  });

  it('rejects unknown keys and names containing "."', () => {
    const found = problems(() =>
      flattenTokens({ x: { $type: 'number', $unknown: 1, 'a.b': { $value: 1 } } }, 'f.json'),
    );
    expect(found).toEqual([
      'f.json: x: unexpected key "$unknown" in a group',
      'f.json: x: name "a.b" may not contain "{", "}" or "."',
    ]);
  });

  it('rejects a primitive in a semantic file', () => {
    const doc = { palette: { $type: 'color', x: { $value: '{palette.gray.0}' } } };
    expect(problems(() => validateTokenSet(setOf(doc, doc))).join('\n')).toMatch(
      /primitive palette\.x belongs in core/,
    );
  });

  it('rejects a set that lacks a category', () => {
    const noMotion = core.filter((def) => !def.path.startsWith('motion.'));
    const light = theme(JSON.parse(readFileSync(join(tokensDir, TOKEN_FILES.light), 'utf8')), 'l');
    const dark = theme(JSON.parse(readFileSync(join(tokensDir, TOKEN_FILES.dark), 'utf8')), 'd');
    expect(problems(() => validateTokenSet({ core: noMotion, themes: { light, dark } }))).toEqual([
      'light: no motion tokens (expected a "motion" group; AC-3)',
      'dark: no motion tokens (expected a "motion" group; AC-3)',
    ]);
  });
});

describe('generator outputs', () => {
  const outputs = buildTokens(packageDir);
  const tokensCss = outputs['dist/css/tokens.css'];
  const themeCss = outputs['src/styles/theme.css'];

  it('names CSS variables with the --ralysa- prefix in kebab case', () => {
    expect(cssVarName('color.fg.onAccent')).toBe('--ralysa-color-fg-on-accent');
    expect(cssVarName('font.lineHeight.body')).toBe('--ralysa-font-line-height-body');
    expect(cssVarName('space.0_5')).toBe('--ralysa-space-0_5');
  });

  it('puts light values on :root and dark values on [data-theme=dark] and prefers-color-scheme', () => {
    expect(tokensCss).toContain(":root,\n[data-theme='light'] {");
    expect(tokensCss).toMatch(
      /\[data-theme='dark'\] \{\n {2}color-scheme: dark;\n[^}]*--ralysa-color-bg-canvas: #101316;/,
    );
    expect(tokensCss).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\[data-theme\]\) \{[^}]*--ralysa-color-fg-default: #e7eaee;/,
    );
  });

  it('emits no primitive palette variables (components use semantic tokens only)', () => {
    expect(tokensCss).not.toMatch(/--ralysa-palette-/);
  });

  it('applies :lang(ar) overrides and zeroes durations under reduced motion', () => {
    expect(tokensCss).toMatch(/:lang\(ar\) \{[^}]*--ralysa-font-line-height-body: 1\.7;/);
    expect(tokensCss).toMatch(/:lang\(ar\) \{[^}]*--ralysa-font-letter-spacing-wide: 0rem;/);
    expect(tokensCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\n {2}:root \{[^}]*--ralysa-motion-duration-slow: 0ms;/,
    );
  });

  it('maps tokens to Tailwind theme variables', () => {
    expect(tailwindVarName('color.bg.canvas')).toBe('--color-canvas');
    expect(tailwindVarName('color.fg.default')).toBe('--color-fg');
    expect(tailwindVarName('color.fg.onAccent')).toBe('--color-fg-on-accent');
    expect(tailwindVarName('color.accent.default')).toBe('--color-accent');
    expect(tailwindVarName('font.size.2xl')).toBe('--text-2xl');
    expect(tailwindVarName('size.control.md')).toBe('--spacing-control-md');
    expect(tailwindVarName('elevation.layer.modal')).toBeUndefined();
    expect(themeCss).toContain('--color-canvas: var(--ralysa-color-bg-canvas);');
    expect(themeCss).toContain('--color-*: initial;');
  });

  it('defines the --ralysa-dir-sign helper for LTR and RTL', () => {
    expect(tokensCss).toContain(":root,\n[dir='ltr'] {\n  --ralysa-dir-sign: 1;\n}");
    expect(tokensCss).toContain("[dir='rtl'] {\n  --ralysa-dir-sign: -1;\n}");
  });

  it.each(['src/tokens/generated.ts', 'src/styles/theme.css'] as const)(
    'matches the committed %s (run `pnpm --filter @ralysa/ui build` after a token change)',
    (file) => {
      expect(readFileSync(join(packageDir, file), 'utf8')).toBe(outputs[file]);
    },
  );
  it('renderGeneratedTs is the generated.ts output', () => {
    expect(outputs['src/tokens/generated.ts']).toBe(
      renderGeneratedTs(validateTokenSet(loadTokenSet(tokensDir))),
    );
  });
});

describe('Tailwind theme through the real entry point (default namespaces reset)', () => {
  // A copy of src/styles/ built from the current token source, so the test also covers an
  // uncommitted token change.
  const dir = mkdtempSync(join(tmpdir(), 'ralysa-ui-tw-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'theme.css'), buildTokens(packageDir)['src/styles/theme.css']);
  const entry = readFileSync(join(packageDir, 'src/styles/tailwind.css'), 'utf8');
  const build = (classes: string[]): Promise<string> => buildTailwind(entry, dir, classes);

  it.each([
    ['bg-canvas', 'var(--ralysa-color-bg-canvas)'],
    ['text-fg-muted', 'var(--ralysa-color-fg-muted)'],
    ['border-border-control', 'var(--ralysa-color-border-control)'],
    ['p-4', 'var(--ralysa-space-4)'],
    ['h-control-md', 'var(--ralysa-size-control-md)'],
    ['rounded-md', 'var(--ralysa-radius-md)'],
    ['text-lg', 'var(--ralysa-font-size-lg)'],
    ['font-sans', 'var(--ralysa-font-family-sans)'],
    ['shadow-md', 'var(--ralysa-elevation-shadow-md)'],
  ])('%s uses %s', async (cls, variable) => {
    expect(await build([cls])).toContain(variable);
  });

  it.each(['bg-red-500', 'text-slate-900', 'bg-white', 'text-black', 'shadow-2xl', 'font-serif'])(
    'the default-palette class %s does not exist',
    async (cls) => {
      const css = await build([cls]);
      expect(css).not.toContain(`.${cls}`);
    },
  );
});
