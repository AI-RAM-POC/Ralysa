// TC-F-001-10 (AC-5): JSX text and string literals in user-visible attributes are errors; t() keys
// and non-visible attributes pass; test files are exempt. Linted through the composed presets,
// with the TypeScript parser and type information (a .tsx file on disk), as a UI workspace does.
// This is also the ESLint 10 check for eslint-plugin-i18next 6.1.5: no fatal message.
import { ESLint, type Linter } from 'eslint';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { base, reactUi, tests } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ENTRY = join(here, 'fixtures/tailwind.css');
const RULE = 'i18next/no-literal-string';
const require = createRequire(import.meta.url);

// A throwaway project outside the package (so a concurrent lint or typecheck of this package
// never sees the fixtures), with a tsconfig so the project service can type the .tsx files.
const scratch = mkdtempSync(join(tmpdir(), 'ralysa-i18n-lint-'));
writeFileSync(
  join(scratch, 'tsconfig.json'),
  JSON.stringify({
    extends: require.resolve('@ralysa/tsconfig/react-lib.json'),
    compilerOptions: { composite: false, noEmit: true, types: [] },
    include: ['*.tsx'],
  }),
);
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const config = (): Linter.Config[] => [
  ...base({ tsconfigRootDir: scratch }),
  ...reactUi({ tailwindEntryPoint: FIXTURE_ENTRY }),
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

  it('known plugin limitation: text under an ALL-CAPS variable name is not reported', async () => {
    // eslint-plugin-i18next treats `const FAQ = …` as a constant and skips its whole initialiser.
    // Recorded in implementation-notes.md (T08-7); the runtime missing-key check and review are
    // the backstop. If this starts failing, the plugin fixed it: turn the case into a report test.
    const file = join(scratch, 'caps.tsx');
    writeFileSync(file, 'export const FAQ = () => <p>Question</p>;\n');
    const [result] = await eslint.lintFiles([file]);
    const ids = result?.messages.map((m) => m.ruleId).filter((id) => id === RULE);
    expect(ids).toEqual([]);
  });
});
