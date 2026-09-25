// PR #17 review B-1: fonts.css's base typography must sit in the `base` cascade layer. Unlayered,
// it beat every Tailwind utility whatever the specificity: `:lang(ar) { line-height }` overrode
// each leading-* under lang="ar", and `code { font-size: 1em }` cancelled text-sm on Code. jsdom
// has no cascade layers, so this reads the built CSS instead: a real Vite build of fonts.css (as
// an app bundles it) and Tailwind's compile of the real entry point (as ui-lab's is).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTokens } from '../scripts/build-tokens.ts';
import { fontLicenses } from '../scripts/font-licenses.ts';
import { buildTailwind } from './tailwind.ts';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const FONTS_CSS = join(packageDir, 'src/styles/fonts.css');
const scratch = mkdtempSync(join(tmpdir(), 'ralysa-fonts-layer-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The at-rule preludes enclosing `index` in `css` (minified or not), outermost first. */
export function enclosingAtRules(css: string, index: number): string[] {
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < index; i++) {
    const c = css[i];
    if (c === '{') {
      stack.push(css.slice(start, i).trim());
      start = i + 1;
    } else if (c === '}') {
      stack.pop();
      start = i + 1;
    } else if (c === ';') {
      start = i + 1;
    }
  }
  return stack.filter((prelude) => prelude.startsWith('@'));
}

/**
 * Top-level cascade layers in order of first appearance, from `@layer a, b;` statements and
 * `@layer a { … }` blocks: the order the cascade uses (later wins).
 */
export function layerOrder(css: string): string[] {
  const order: string[] = [];
  let depth = 0;
  let start = 0;
  const add = (prelude: string): void => {
    const match = /^@layer\s+([^{;]+)/.exec(prelude.trim());
    if (depth !== 0 || !match) return;
    for (const name of (match[1] ?? '').split(',').map((n) => n.trim())) {
      if (name && !order.includes(name)) order.push(name);
    }
  };
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      add(css.slice(start, i));
      depth++;
      start = i + 1;
    } else if (c === '}') {
      depth--;
      start = i + 1;
    } else if (c === ';') {
      add(css.slice(start, i));
      start = i + 1;
    }
  }
  return order;
}

/** Top-level rules that are neither in a layer nor an @font-face / @import / @layer statement. */
function unlayeredRules(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      const prelude = css.slice(start, i).trim();
      if (depth === 0 && !/^@(layer|font-face)\b/.test(prelude)) out.push(prelude);
      depth++;
      start = i + 1;
    } else if (c === '}') {
      depth--;
      start = i + 1;
    } else if (c === ';') {
      start = i + 1;
    }
  }
  return out;
}

// The rules fonts.css sets, as they appear in minified output.
const FONT_RULES = [
  ':root{font-family:var(--ralysa-font-family-sans)',
  '[lang|=ar]{line-height:var(--ralysa-font-line-height-body)',
  'code,kbd,samp,pre{font-family:var(--ralysa-font-family-mono)',
];

describe('fonts.css: base typography sits in @layer base (PR #17 B-1)', () => {
  let fontsCss = '';
  let tailwindCss = '';

  beforeAll(async () => {
    const root = join(scratch, 'app');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'entry.js'), `import '${FONTS_CSS}';\n`);
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [fontLicenses()],
      build: {
        outDir: 'dist',
        emptyOutDir: true,
        rollupOptions: { input: join(root, 'entry.js') },
      },
    });
    const assets = join(root, 'dist/assets');
    const cssFile = readdirSync(assets).find((f) => f.endsWith('.css'));
    fontsCss = readFileSync(join(assets, cssFile ?? 'missing.css'), 'utf8');

    const theme = join(scratch, 'theme');
    mkdirSync(theme, { recursive: true });
    writeFileSync(join(theme, 'theme.css'), buildTokens(packageDir)['src/styles/theme.css']);
    const entry = readFileSync(join(packageDir, 'src/styles/tailwind.css'), 'utf8');
    tailwindCss = await buildTailwind(entry, theme, ['leading-tight', 'text-sm']);
  }, 60_000);

  it.each(FONT_RULES)('the built CSS has %s… inside @layer base', (rule) => {
    const index = fontsCss.indexOf(rule);
    expect(index, rule).toBeGreaterThanOrEqual(0);
    expect(enclosingAtRules(fontsCss, index)).toEqual(['@layer base']);
  });

  it('no style rule is left outside a layer (only @font-face is)', () => {
    expect(unlayeredRules(fontsCss)).toEqual([]);
  });

  it('the Arabic rule matches the element declaring the language only, not every descendant', () => {
    expect(fontsCss).not.toContain(':lang(ar)');
  });

  it('Tailwind puts utilities in @layer utilities, after base, whichever stylesheet loads first', () => {
    for (const rule of [/\.leading-tight\s*\{/, /\.text-sm\s*\{/]) {
      const index = tailwindCss.search(rule);
      expect(index, String(rule)).toBeGreaterThanOrEqual(0);
      expect(enclosingAtRules(tailwindCss, index), String(rule)).toEqual(['@layer utilities']);
    }
    for (const bundle of [fontsCss + tailwindCss, tailwindCss + fontsCss]) {
      const order = layerOrder(bundle);
      expect(order.indexOf('base')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('utilities')).toBeGreaterThan(order.indexOf('base'));
    }
  });

  it("preflight's font families are the Ralysa stacks, so its base rules agree with fonts.css", () => {
    // `@theme inline` substitutes --default-(mono-)font-family into preflight's html and
    // code/kbd/samp/pre rules; :root { line-height } in fonts.css beats preflight's html by
    // specificity inside the shared base layer.
    expect(tailwindCss).toMatch(
      /html,\s*:host\s*\{[^}]*font-family:\s*var\(--ralysa-font-family-sans\b/,
    );
    expect(tailwindCss).toMatch(
      /code,\s*kbd,\s*samp,\s*pre\s*\{[^}]*font-family:\s*var\(--ralysa-font-family-mono\b/,
    );
  });
});
