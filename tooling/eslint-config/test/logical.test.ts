// TC-F-001-08 (AC-4), ESLint part: every physical form in §7.3.3 (Tailwind classes) and §7.3.5
// (inline styles) is an error, and each logical equivalent passes. Also the Tailwind half of
// TC-F-001-07 (AC-3): arbitrary colour values and default-palette classes are errors.
import { ESLint, type Linter, RuleTester } from 'eslint';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { base, reactUi, tests } from '../index.js';
import { noPhysicalInlineStyle } from '../rules/no-physical-inline-style.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const FIXTURE_ENTRY = join(here, 'fixtures/tailwind.css');

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
});

const property = { messageId: 'property' } as const;
const value = { messageId: 'value' } as const;

ruleTester.run('ralysa/no-physical-inline-style', noPhysicalInlineStyle, {
  valid: [
    '<div style={{ marginInlineStart: 4, paddingInlineEnd: 8, insetInlineStart: 0 }} />',
    '<div style={{ borderInlineStart: "1px solid", borderStartEndRadius: 4 }} />',
    '<div style={{ marginTop: 4, paddingBottom: 4, top: 0, bottom: 0, width: 10, height: 10 }} />',
    '<div style={{ textAlign: "start", float: "inline-end", clear: "inline-start" }} />',
    '<div style={{ textAlign: "center" }} />',
    '<div style={{ ["marginLeft"]: 4 }} />', // computed keys are not analysed
    '<div data-left="1" left={4} />',
    '<div style={styles} />',
  ],
  invalid: [
    ...[
      'marginLeft',
      'marginRight',
      'paddingLeft',
      'paddingRight',
      'left',
      'right',
      'borderLeft',
      'borderRight',
      'borderLeftColor',
      'borderRightColor',
      'borderLeftStyle',
      'borderRightStyle',
      'borderLeftWidth',
      'borderRightWidth',
      'borderTopLeftRadius',
      'borderTopRightRadius',
      'borderBottomLeftRadius',
      'borderBottomRightRadius',
      'scrollMarginLeft',
      'scrollMarginRight',
      'scrollPaddingLeft',
      'scrollPaddingRight',
    ].map((key) => ({ code: `<div style={{ ${key}: 4 }} />`, errors: [property] })),
    { code: '<div style={{ textAlign: "left" }} />', errors: [value] },
    { code: '<div style={{ textAlign: "right" }} />', errors: [value] },
    { code: '<div style={{ float: "left" }} />', errors: [value] },
    { code: '<div style={{ float: "right" }} />', errors: [value] },
    { code: '<div style={{ clear: "left" }} />', errors: [value] },
    { code: '<div style={{ clear: "right" }} />', errors: [value] },
    { code: '<div style={{ "marginLeft": 4 }} />', errors: [property] },
    { code: '<div style={open ? { left: 0 } : { right: 0 }} />', errors: [property, property] },
    { code: '<div style={open && { paddingLeft: 4 }} />', errors: [property] },
    { code: '<div style={{ ...base, marginRight: 4 }} />', errors: [property] },
    { code: '<div style={{ ...{ marginRight: 4 } }} />', errors: [property] },
    { code: '<div style={{ left: 0 } as CSSProperties} />', errors: [property] },
    { code: '<div style={{ right: 0 } satisfies CSSProperties} />', errors: [property] },
  ],
});

it('names the logical property in the message', async () => {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      ...base({ tsconfigRootDir: root }),
      ...reactUi({ tailwindEntryPoint: FIXTURE_ENTRY }),
    ],
  });
  const [result] = await eslint.lintText('export const x = <div style={{ marginLeft: 4 }} />;\n', {
    filePath: join(root, 'src/fixture.jsx'),
  });
  const message = result?.messages.find((m) => m.ruleId === 'ralysa/no-physical-inline-style');
  expect(message?.message).toMatch(/Use "marginInlineStart"/);
});

describe('Tailwind classes (better-tailwindcss)', () => {
  const config = (entry?: string): Linter.Config[] => [
    ...base({ tsconfigRootDir: root }),
    ...reactUi(entry === undefined ? {} : { tailwindEntryPoint: entry }),
    ...tests(),
  ];
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: config(FIXTURE_ENTRY),
  });

  async function ruleIdsFor(
    code: string,
    instance = eslint,
    file = 'src/fixture.jsx',
  ): Promise<string[]> {
    const [result] = await instance.lintText(code, { filePath: join(root, file) });
    return (result?.messages ?? [])
      .map((m) => m.ruleId ?? `fatal: ${m.message}`)
      .filter((id) => !id.startsWith('jsx-a11y/') && !id.startsWith('@eslint-react/'));
  }
  const classRules = (className: string): Promise<string[]> =>
    ruleIdsFor(`export const x = <div className="${className}" />;\n`);

  const LOGICAL = 'better-tailwindcss/enforce-logical-properties';
  const RESTRICTED = 'better-tailwindcss/no-restricted-classes';
  const UNKNOWN = 'better-tailwindcss/no-unknown-classes';

  it.each([
    ['ml-4', 'ms-4'],
    ['mr-4', 'me-4'],
    ['pl-4', 'ps-4'],
    ['pr-4', 'pe-4'],
    ['-ml-2', '-ms-2'],
    ['left-4', 'inset-s-4'],
    ['right-0', 'inset-e-0'],
    ['border-l', 'border-s'],
    ['border-r-2', 'border-e-2'],
    ['rounded-l-md', 'rounded-s-md'],
    ['rounded-r-md', 'rounded-e-md'],
    ['rounded-tl-md', 'rounded-ss-md'],
    ['rounded-tr-md', 'rounded-se-md'],
    ['rounded-bl-md', 'rounded-es-md'],
    ['rounded-br-md', 'rounded-ee-md'],
    ['text-left', 'text-start'],
    ['text-right', 'text-end'],
    ['float-left', 'float-start'],
    ['float-right', 'float-end'],
    ['clear-left', 'clear-start'],
    ['clear-right', 'clear-end'],
    ['scroll-ml-4', 'scroll-ms-4'],
    ['scroll-pr-4', 'scroll-pe-4'],
    ['md:hover:ml-4', 'md:hover:ms-4'],
  ])('%s → enforce-logical-properties; %s passes', async (physical, logical) => {
    expect(await classRules(physical)).toEqual([LOGICAL]);
    expect(await classRules(logical)).toEqual([]);
  });

  it.each([
    'mt-4',
    'mb-4',
    'pt-2',
    'pb-2',
    'top-0',
    'bottom-4',
    'border-t',
    'border-b-2',
    'h-4',
    'w-4',
    'size-4',
    'max-w-full',
    'rounded-t-md',
  ])('block-axis and sizing classes stay allowed: %s', async (className) => {
    expect(await classRules(className)).toEqual([]);
  });

  it.each([
    ['translate-x-4', 'translate-y-4'],
    ['-translate-x-4', 'ltr:translate-x-4 rtl:-translate-x-4'],
    ['hover:translate-x-2', 'hover:ltr:translate-x-2 hover:rtl:-translate-x-2'],
    ['bg-left', 'ltr:bg-left rtl:bg-right'],
    ['bg-right-top', 'bg-top'],
    ['bg-top-left', 'bg-center'],
    ['origin-left', 'origin-center'],
    ['origin-top-right', 'ltr:origin-top-right rtl:origin-top-left'],
    ['bg-linear-to-r', 'bg-linear-to-b'],
    ['bg-linear-to-tl', 'ltr:bg-linear-to-l rtl:bg-linear-to-r'],
    ['bg-gradient-to-l', 'bg-gradient-to-t'],
    ['[margin-left:4px]', '[margin-inline-start:4px]'],
    ['[border-top-right-radius:4px]', '[border-start-end-radius:4px]'],
    ['[text-align:right]', '[text-align:end]'],
  ])('%s → no-restricted-classes; %s passes', async (physical, logical) => {
    expect(await classRules(physical)).toEqual([RESTRICTED]);
    expect(await classRules(logical)).toEqual([]);
  });

  it.each(['bg-[#fff]', 'text-[rgb(0_0_0)]', 'border-[oklch(62%_0.2_250)]', 'bg-[color:#abcdef]'])(
    'arbitrary colour %s → no-restricted-classes and no-raw-color (AC-3)',
    async (className) => {
      const ids = await classRules(className);
      expect(ids).toContain(RESTRICTED);
    },
  );

  it.each(['bg-red-500', 'text-slate-900', 'bg-white', 'p-7', 'rounded-3xl'])(
    'default-palette or untokened class %s → no-unknown-classes (AC-3)',
    async (className) => {
      expect(await classRules(className)).toEqual([UNKNOWN]);
    },
  );

  it.each(['bg-canvas text-fg p-4 rounded-md', 'flex gap-2 hover:bg-canvas', 'sr-only'])(
    'token-backed and structural classes pass: %s',
    async (className) => {
      expect(await classRules(className)).toEqual([]);
    },
  );

  it.each(["cn('ml-4')", "clsx('text-left')", "cva('pl-2')", "tv({ base: 'pr-2' })"])(
    'checks class strings in callees: %s',
    async (call) => {
      expect(await ruleIdsFor(`export const x = ${call};\n`)).toEqual([LOGICAL]);
    },
  );

  it('does not apply the design-system rules to test files', async () => {
    expect(
      await ruleIdsFor(
        'export const x = <div className="ml-4 bg-red-500" />;\n',
        eslint,
        'test/a.test.jsx',
      ),
    ).toEqual([]);
  });

  it('without an entry point, token-backed classes are unknown (fail loudly)', async () => {
    const fallback = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: config() });
    expect(
      await ruleIdsFor('export const x = <div className="bg-canvas p-4 flex" />;\n', fallback),
    ).toEqual([UNKNOWN, UNKNOWN]);
  });
});
