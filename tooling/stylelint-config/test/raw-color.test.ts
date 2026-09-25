// TC-F-001-07 (AC-3), Stylelint part: hex, rgb, hsl, oklch and the other colour functions, and
// named colours, are errors in component CSS; tokens, color-mix() over var() and the CSS-wide
// keywords pass; token definition files and generated CSS are exempt.
import { describe, expect, it } from 'vitest';
import { lintCss, rulesFor } from './lint.js';

describe('raw colours in CSS (AC-3)', () => {
  it.each([
    ['.a { color: #fff; }', 'color-no-hex'],
    ['.a { color: #1A1D21; }', 'color-no-hex'],
    ['.a { border: 1px solid #11223344; }', 'color-no-hex'],
    ['.a { color: red; }', 'color-named'],
    ['.a { background: rebeccapurple; }', 'color-named'],
    ['.a { color: rgb(0 0 0); }', 'function-disallowed-list'],
    ['.a { color: rgba(0, 0, 0, 0.5); }', 'function-disallowed-list'],
    ['.a { color: hsl(210 20% 50%); }', 'function-disallowed-list'],
    ['.a { color: hsla(210, 20%, 50%, 0.5); }', 'function-disallowed-list'],
    ['.a { color: hwb(12 50% 0%); }', 'function-disallowed-list'],
    ['.a { color: lab(50% 40 59); }', 'function-disallowed-list'],
    ['.a { color: lch(52% 72 56); }', 'function-disallowed-list'],
    ['.a { color: oklab(0.6 0.1 -0.1); }', 'function-disallowed-list'],
    ['.a { color: oklch(62% 0.2 250); }', 'function-disallowed-list'],
    ['.a { color: color(display-p3 1 0 0); }', 'function-disallowed-list'],
    ['.a { box-shadow: 0 1px 2px rgb(0 0 0 / 0.1); }', 'function-disallowed-list'],
    ['@theme { --color-brand: #2b55c9; }', 'color-no-hex'],
  ])('%s → %s', async (code, rule) => {
    expect(await rulesFor(code)).toContain(rule);
  });

  it.each([
    '.a { color: var(--ralysa-color-fg-default); }',
    '.a { background: color-mix(in srgb, var(--ralysa-color-accent-default) 20%, transparent); }',
    '.a { color: currentcolor; border-color: transparent; }',
    '.a { color: inherit; background: none; }',
    '@import "tailwindcss";\n@theme inline { --color-canvas: var(--ralysa-color-bg-canvas); }',
  ])('passes: %s', async (code) => {
    expect(await rulesFor(code)).toEqual([]);
  });

  it.each(['packages/ui/tokens/brand.css', 'packages/ui/dist/css/tokens.css'])(
    'ignores token definition and generated files: %s',
    async (file) => {
      expect(await rulesFor('.a { color: #fff; }', file)).toEqual([]);
    },
  );

  it('names the token alternative in the message', async () => {
    const [warning] = await lintCss('.a { color: #fff; }');
    expect(warning?.text).toMatch(/design token/);
  });
});

describe('disable comments', () => {
  it('requires a description', async () => {
    const rules = await rulesFor(
      '/* stylelint-disable-next-line color-no-hex */\n.a { color: #fff; }',
    );
    expect(rules).toContain('--report-descriptionless-disables');
  });

  it('accepts a described disable', async () => {
    const rules = await rulesFor(
      '/* stylelint-disable-next-line color-no-hex -- print-only fallback, reviewed */\n.a { color: #fff; }',
    );
    expect(rules).toEqual([]);
  });

  it('reports a disable that suppresses nothing', async () => {
    const rules = await rulesFor(
      '/* stylelint-disable-next-line color-no-hex -- stale */\n.a { color: var(--x); }',
    );
    expect(rules).toContain('--report-needless-disables');
  });
});
