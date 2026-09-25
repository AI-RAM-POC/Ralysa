// TC-F-001-10 (AC-5): JSX text and string literals in user-visible attributes are errors; t() keys
// and non-visible attributes pass; test files are exempt. Linted through the composed presets,
// with the TypeScript parser and type information (a .tsx file on disk), as a UI workspace does.
// This is also the ESLint 10 check for eslint-plugin-i18next 6.1.5: no fatal message.
import { ESLint, type Linter } from 'eslint';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { base, reactUi, tests } from '../index.js';
import { UI_RESTRICTED_SYNTAX } from '../react-ui.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ENTRY = join(here, 'fixtures/tailwind.css');
const RULE = 'i18next/no-literal-string';

// A throwaway project outside the package (so a concurrent lint or typecheck of this package
// never sees the fixtures), with a tsconfig so the project service can type the .tsx files.
const scratch = mkdtempSync(join(tmpdir(), 'ralysa-i18n-lint-'));
writeFileSync(
  join(scratch, 'tsconfig.json'),
  JSON.stringify({
    extends: fileURLToPath(import.meta.resolve('@ralysa/tsconfig/react-lib.json')),
    compilerOptions: { composite: false, noEmit: true, types: [] },
    include: ['*.tsx'],
  }),
);
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const config = (): Linter.Config[] => [
  ...base({ tsconfigRootDir: scratch }),
  ...reactUi({ workspaceDir: scratch, tailwindEntryPoint: FIXTURE_ENTRY }),
  ...tests(),
];
const eslint = new ESLint({ cwd: scratch, overrideConfigFile: true, overrideConfig: config() });

let counter = 0;
async function lint(body: string, name?: string): Promise<Linter.LintMessage[]> {
  counter += 1;
  const file = join(scratch, name ?? `fixture${String(counter)}.tsx`);
  const code = `declare const t: (key: string) => string;\ndeclare const Button: (props: { label?: string; kind?: string; children?: unknown }) => null;\nexport const Screen = () => (\n  ${body}\n);\n`;
  writeFileSync(file, code);
  const [result] = await eslint.lintFiles([file]);
  return result?.messages ?? [];
}
const ATTRIBUTE_RULE = 'ralysa/no-literal-attribute-text';
const ruleIds = async (body: string, name?: string): Promise<string[]> =>
  (await lint(body, name))
    .map((m) => m.ruleId ?? `fatal: ${m.message}`)
    .filter((id) => id === RULE || id === ATTRIBUTE_RULE || id.startsWith('fatal'));

describe('no hard-coded UI strings (AC-5)', () => {
  it.each([
    ['JSX text', '<h1>Hello world</h1>'],
    ['JSX text in a fragment', '<>Save changes</>'],
    ['a string child expression', "<p>{'Hello'}</p>"],
    ['a template literal child', '<p>{`Hello`}</p>'],
    ['ALL-CAPS JSX text (the plugin default would exempt it)', '<p>OK</p>'],
    ['Arabic JSX text', '<p>مرحبا</p>'],
  ])('i18next/no-literal-string reports %s', async (_what, body) => {
    expect(await ruleIds(body)).toEqual([RULE]);
  });

  it.each([
    ['aria-label', '<button type="button" aria-label="Close" />'],
    ['aria-description on a native element', '<div aria-description="More about this" />'],
    ['aria-roledescription', '<div aria-roledescription="slide" />'],
    [
      'aria-valuetext',
      '<div role="slider" aria-valuenow={3} aria-valuetext="Three stars" tabIndex={0} />',
    ],
    ['title', '<span title="Tooltip text" />'],
    ['alt', '<img src="/logo.svg" alt="Company logo" />'],
    ['placeholder', '<input placeholder="Search…" />'],
    ['label on a native element', '<select><option label="First" value="1" /></select>'],
    ['label on a component', '<Button label="Submit" />'],
    ['a literal inside an expression', '<Button label={"Submit"} />'],
    ['a literal branch of a condition', "<span title={open ? 'Open' : t('ui:state.closed')} />"],
    // Code review 8: string concatenation.
    ['a concatenation', "<button type=\"button\" aria-label={'Close ' + 'dialog'} />"],
    ['a concatenation with an expression', "<span title={'Hello ' + t('ui:x.y')} />"],
    // Code review 2: value is the visible label of submit/reset/button inputs.
    ['value on input type=reset', '<input type="reset" value="Clear form" />'],
    ['value on input type=submit', '<input type="submit" value="Send" />'],
    ['value on input type={"button"}', '<input type={"button"} value="Go" />'],
    ['value on input type={`submit`}', '<input type={`submit`} value="Send" />'],
  ])('ralysa/no-literal-attribute-text reports %s', async (_what, body) => {
    expect(await ruleIds(body.replace('open ?', '(Math.random() > 0.5) ?'))).toEqual([
      ATTRIBUTE_RULE,
    ]);
  });

  it.each([
    ['a t() key', "<h1>{t('web:app.name')}</h1>"],
    [
      'a t() key in aria-label',
      '<button type="button" aria-label={t(\'ui:iconButton.close.label\')} />',
    ],
    ['className', '<div className="flex gap-2" />'],
    ['data-* and id', '<div data-testid="save-button" id="main" />'],
    ['href and type', '<a href="/docs">{t(\'ui:link.docs\')}</a>'],
    ['role and other non-text ARIA', '<div role="alert" aria-live="polite" aria-hidden="true" />'],
    ['a non-visible component prop', '<Button kind="primary">{t(\'ui:button.save\')}</Button>'],
    ['punctuation and digits only', '<span>— 42 % · 3/4</span>'],
    ['an attribute with no letters', '<span title="—" />'],
    [
      'value on a text input or an option',
      '<><input type="text" value="draft" readOnly /><select><option value="en">{t(\'ui:locale.name.en\')}</option></select></>',
    ],
    [
      'value on an input with a dynamic type',
      '<input type={kind} value="x" readOnly />'.replace(
        'kind',
        "(Math.random() > 0.5 ? 'text' : 'search')",
      ),
    ],
    ['a concatenation without letters', "<span title={'#' + '1'} />"],
    ['a string outside JSX', "(() => { const mode = 'compact'; return null; })()"],
  ])('allows %s', async (_what, body) => {
    expect(await ruleIds(body)).toEqual([]);
  });

  it('names the fix in the messages', async () => {
    const [text] = (await lint('<h1>Hello world</h1>')).filter((m) => m.ruleId === RULE);
    expect(text?.message).toMatch(/i18n key.*AC-5/);
    const [attribute] = (await lint('<img src="/a.svg" alt="Logo" />')).filter(
      (m) => m.ruleId === ATTRIBUTE_RULE,
    );
    expect(attribute?.message).toMatch(/alt=\{t\("ns:area\.element"\)\}.*AC-5/);
  });

  it('does not apply to test files', async () => {
    expect(await ruleIds('<h1 title="Title">Hello world</h1>', 'thing.test.tsx')).toEqual([]);
  });

  it('keeps both rules at error for UI source files', async () => {
    const resolved = (await eslint.calculateConfigForFile(join(scratch, 'a.tsx'))) as {
      rules: Record<string, [number]>;
    };
    expect(resolved.rules[RULE]?.[0]).toBe(2);
    expect(resolved.rules[ATTRIBUTE_RULE]?.[0]).toBe(2);
  });

  // T08-7, closed (code review 1): eslint-plugin-i18next skips the initialiser of an ALL-CAPS
  // variable; the react-ui no-restricted-syntax entry reports the text there instead.
  const SYNTAX = 'no-restricted-syntax';
  async function fileRuleIds(code: string): Promise<(string | null)[]> {
    const file = join(scratch, `caps${String((counter += 1))}.tsx`);
    writeFileSync(file, code);
    const [result] = await eslint.lintFiles([file]);
    return (result?.messages ?? [])
      .map((m) => m.ruleId)
      .filter((id) => id === RULE || id === SYNTAX || id === ATTRIBUTE_RULE);
  }

  it.each([
    'export const FAQ = () => <p>Question</p>;\n',
    'export const ROUTES = [{ element: <main><h1>Home page</h1></main> }];\n',
    'const LABELS = { save: <span>Save</span> };\nexport default LABELS;\n',
    "const LABELS = { save: <span>{'Save'}</span> };\nexport default LABELS;\n",
    'const LABELS = { save: <span>{`Save`}</span> };\nexport default LABELS;\n',
    'const LABELS = { save: <span>حفظ</span> };\nexport default LABELS;\n',
  ])('closed: JSX text under an ALL-CAPS variable is reported: %s', async (code) => {
    expect(await fileRuleIds(code)).toEqual([SYNTAX]);
  });

  it('closed: t() keys and letter-free text under an ALL-CAPS variable pass', async () => {
    expect(
      await fileRuleIds(
        "declare const t: (key: string) => string;\nexport const LABELS = { save: <span>{t('ui:button.save')}</span>, sep: <span> · </span> };\n",
      ),
    ).toEqual([]);
  });

  it('keeps the base preset no-restricted-syntax entries when adding the UI one', async () => {
    const resolved = (await eslint.calculateConfigForFile(join(scratch, 'a.tsx'))) as {
      rules: Record<string, [number, ...{ selector: string }[]]>;
    };
    const [severity, ...entries] = resolved.rules[SYNTAX] ?? [0];
    expect(severity).toBe(2);
    const { RESTRICTED_SYNTAX } = await import('../boundaries.js');
    // Every one of main's loading-ban selectors (T04 and the review-nits follow-up), in order,
    // followed by the UI one: nothing replaces anything.
    expect(entries).toEqual([...RESTRICTED_SYNTAX, ...UI_RESTRICTED_SYNTAX]);
    const selectors = entries.map((e) => e.selector);
    expect(selectors.some((s) => s.includes("property.name='mainModule'"))).toBe(true);
    expect(selectors.some((s) => s.includes('require'))).toBe(true);
    expect(selectors.some((s) => s.includes('VariableDeclarator'))).toBe(true);
  });

  it.each([
    ['the require handle', 'export const r = module.require.bind(module);\n'],
    ['process.mainModule', 'export const m = process.mainModule;\n'],
    ['a non-literal import()', 'const spec = "x";\nexport const p = import(spec);\n'],
  ])('main loading ban still fires in a UI file: %s', async (_what, code) => {
    expect(await fileRuleIds(code)).toContain(SYNTAX);
  });

  it('a LOADING_EXCEPTIONS file keeps the exception and the UI selector', async () => {
    const { LOADING_EXCEPTIONS, RESTRICTED_SYNTAX } = await import('../boundaries.js');
    LOADING_EXCEPTIONS.push({ files: ['packages/x/src/legacy/**'], reason: 'test fixture' });
    try {
      const withException = new ESLint({
        cwd: scratch,
        overrideConfigFile: true,
        overrideConfig: [
          ...base({ tsconfigRootDir: scratch, workspace: 'packages/x' }),
          ...reactUi({ tailwindEntryPoint: FIXTURE_ENTRY, workspace: 'packages/x' }),
          ...tests(),
        ],
      });
      const rule = async (file: string): Promise<unknown[]> =>
        (
          (await withException.calculateConfigForFile(join(scratch, file))) as {
            rules: Record<string, unknown[]>;
          }
        ).rules[SYNTAX] ?? [];
      expect(await rule('src/legacy/a.tsx')).toEqual([2, ...UI_RESTRICTED_SYNTAX]);
      expect(await rule('src/a.tsx')).toEqual([2, ...RESTRICTED_SYNTAX, ...UI_RESTRICTED_SYNTAX]);
    } finally {
      LOADING_EXCEPTIONS.pop();
    }
  });
});
