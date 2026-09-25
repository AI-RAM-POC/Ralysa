// TC-F-001-07 (AC-3), ESLint part: raw colours in UI TS/TSX are errors; token usage passes; test
// files are exempt. The Stylelint part is in tooling/stylelint-config/test/.
import { ESLint, type Linter, RuleTester } from 'eslint';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { base, reactUi, tests } from '../index.js';
import { findRawColor, noRawColor } from '../rules/no-raw-color.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const error = { messageId: 'rawColor' } as const;

ruleTester.run('ralysa/no-raw-color', noRawColor, {
  valid: [
    "const c = 'bg-canvas text-fg border-border-control';",
    "const v = 'var(--ralysa-color-bg-canvas)';",
    "const m = 'color-mix(in srgb, var(--ralysa-color-accent) 20%, transparent)';",
    "const hash = '#main';", // a fragment link, not a colour
    "const entity = '&#123;';",
    "const text = 'the colour (red) of the thing';",
    "const id = 'issue-#12345';",
    "import x from '#internal/fff';\nexport { x };",
    'const n = 0xfff;',
    "const style = { background: 'var(--ralysa-color-bg-subtle)' };",
    'const el = <div className="bg-surface p-4" />;',
  ],
  invalid: [
    { code: "const c = '#fff';", errors: [error] },
    { code: "const c = '#FFFFFF';", errors: [error] },
    { code: "const c = '#11223344';", errors: [error] },
    { code: "const c = '1px solid #cccccc';", errors: [error] },
    { code: "const c = 'rgb(0 0 0)';", errors: [error] },
    { code: "const c = 'rgba(0, 0, 0, 0.5)';", errors: [error] },
    { code: "const c = 'hsl(210 20% 50%)';", errors: [error] },
    { code: "const c = 'hsla(210, 20%, 50%, 0.4)';", errors: [error] },
    { code: "const c = 'oklch(62% 0.2 250)';", errors: [error] },
    { code: "const c = 'oklab(0.6 0.1 -0.1)';", errors: [error] },
    { code: "const c = 'lab(50% 40 59)';", errors: [error] },
    { code: "const c = 'lch(52% 72 56)';", errors: [error] },
    { code: "const c = 'hwb(12 50% 0%)';", errors: [error] },
    { code: "const c = 'color(display-p3 1 0 0)';", errors: [error] },
    { code: 'const c = `${base} #abc`;', errors: [error] },
    { code: 'const c = `rgb(${r} ${g} ${b})`;', errors: [error] },
    { code: "const style = { color: '#1a1d21' };", errors: [error] },
    { code: 'const el = <div className="bg-[#fff]" />;', errors: [error] },
    { code: 'const el = <div className="text-[rgb(0_0_0)]" />;', errors: [error] },
    { code: 'const el = <div className="border-[oklch(62%_0.2_250)]" />;', errors: [error] },
    { code: "const el = <div style={{ borderColor: 'hsl(0 0% 50%)' }} />;", errors: [error] },
  ],
});

describe('findRawColor', () => {
  it('returns the offending value', () => {
    expect(findRawColor('bg-[#abcdef]')).toBe('#abcdef');
    expect(findRawColor('x rgb(1 2 3)')).toBe('rgb(');
    expect(findRawColor('bg-canvas')).toBeUndefined();
  });
});

describe('react-ui preset: raw colours (AC-3)', () => {
  const config = (): Linter.Config[] => [
    ...base({ tsconfigRootDir: root }),
    ...reactUi(),
    ...tests(),
  ];
  async function ruleIds(code: string, file: string): Promise<string[]> {
    const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: config() });
    const [result] = await eslint.lintText(code, { filePath: join(root, file) });
    return (result?.messages ?? []).map((m) => m.ruleId ?? 'fatal');
  }

  it('reports a raw colour in component code', async () => {
    const ids = await ruleIds(
      "export const style = { color: '#1a1d21' };\n",
      'src/components/thing.js',
    );
    expect(ids).toContain('ralysa/no-raw-color');
  });

  it('does not report test files', async () => {
    const ids = await ruleIds("export const expected = '#1a1d21';\n", 'test/thing.test.js');
    expect(ids).not.toContain('ralysa/no-raw-color');
  });

  it('keeps the rule at error for UI source files', async () => {
    const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: config() });
    const resolved = (await eslint.calculateConfigForFile(join(root, 'src/a.tsx'))) as {
      rules: Record<string, [number]>;
    };
    expect(resolved.rules['ralysa/no-raw-color']?.[0]).toBe(2);
  });
});
