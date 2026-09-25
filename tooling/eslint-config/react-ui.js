// `react-ui` is the UI lint layer for React packages and apps: @eslint-react, the Rules of
// Hooks and jsx-a11y at `strict`. jsx-a11y 6.10.2 declares ESLint <= 9, so it is wrapped with
// @eslint/compat (F-001 design §2.2, §7.8; the T02 spike result is in implementation-notes.md).
// It also holds the design-system guard-rails, which test files are exempt from (they aren't
// component or app code):
//   - no raw colours (§7.3.4, AC-3): ralysa/no-raw-color, and arbitrary colour classes
//   - logical layout (§7.3.3, §7.3.5, AC-4): better-tailwindcss enforce-logical-properties and
//     no-restricted-classes, and ralysa/no-physical-inline-style
//   - only token-backed Tailwind classes (§7.1.1): better-tailwindcss no-unknown-classes against
//     the workspace's Tailwind entry point (`@ralysa/ui/tailwind.css`)
//   - no hard-coded UI strings (§7.4.4, AC-5): i18next/no-literal-string reports JSX text and
//     string literals in user-visible attributes; everything else (className, data-*, id, href,
//     type, test ids, ...) is ignored. Demo sample content lives in JSON, not TSX literals.
import eslintReact from '@eslint-react/eslint-plugin';
import { fixupPluginRules } from '@eslint/compat';
import betterTailwind from 'eslint-plugin-better-tailwindcss';
import i18next from 'eslint-plugin-i18next';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { dirname } from 'node:path';
import { boundaryRules, JS_FILES, workspaceGlob, workspaceOf } from './base.js';
import { LOADING_EXCEPTIONS } from './boundaries.js';
import { ralysaPlugin } from './rules/index.js';
import { LOGICAL_IGNORE, NO_THEME_ENTRY_POINT, RESTRICTED_CLASSES } from './tailwind.js';
import { TEST_FILES } from './tests.js';

export const UI_FILES = ['**/*.{js,mjs,jsx,ts,tsx}'];

/**
 * eslint-plugin-i18next skips the whole initialiser of an ALL-CAPS variable (it treats
 * `const FAQ = …` as a constant), so JSX text there escaped AC-5 (code review 1). This selector
 * closes that gap: any letter-bearing JSX text or string/template child under such a variable.
 * esquery accepts the `u` flag, so `\p{L}` covers Arabic as well as Latin.
 * @type {import('./boundaries.js').RestrictedSyntax[]}
 */
export const UI_RESTRICTED_SYNTAX = [
  {
    selector:
      'VariableDeclarator[id.name=/^[A-Z][A-Z0-9_]*$/] :matches(JSXText[value=/\\p{L}/u], JSXExpressionContainer > Literal[value=/\\p{L}/u], JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=/\\p{L}/u])',
    message:
      'User-visible text must come from an i18n key, e.g. t("ns:area.element") (AC-5). ALL-CAPS variables are not exempt.',
  },
];

/**
 * JSX attributes whose string value a user reads or hears (§7.4.4). The design's list is
 * aria-label, aria-description, title, alt, placeholder and label; the other ARIA text
 * attributes are added for the same reason.
 */
export const USER_VISIBLE_ATTRIBUTES = [
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-placeholder',
  'aria-valuetext',
  'title',
  'alt',
  'placeholder',
  'label',
];

const jsxA11yPlugin = fixupPluginRules(jsxA11y);

/**
 * @param {{
 *   files?: string[],
 *   tailwindEntryPoint?: string,
 *   workspace?: string,
 * }} [options] `tailwindEntryPoint` is the absolute path of the workspace's Tailwind CSS entry
 *   point, normally `fileURLToPath(import.meta.resolve('@ralysa/ui/tailwind.css'))`. Without it,
 *   every token-backed class is reported as unknown. `workspace` (repo-relative, derived from the
 *   working directory like base()'s) places the LOADING_EXCEPTIONS globs; tests override it.
 * @returns {import('eslint').Linter.Config[]}
 */
export function reactUi({
  files = UI_FILES,
  tailwindEntryPoint = NO_THEME_ENTRY_POINT,
  workspace = workspaceOf(process.cwd()),
} = {}) {
  return [
    {
      ...eslintReact.configs['recommended-type-checked'],
      name: 'ralysa/react-ui/eslint-react',
      files,
    },
    {
      ...eslintReact.configs['disable-type-checked'],
      name: 'ralysa/react-ui/eslint-react-js',
      files: JS_FILES,
    },
    {
      ...reactHooks.configs.flat.recommended,
      name: 'ralysa/react-ui/react-hooks',
      files,
    },
    {
      name: 'ralysa/react-ui/jsx-a11y',
      files,
      plugins: { 'jsx-a11y': jsxA11yPlugin },
      languageOptions: {
        parserOptions: { ecmaFeatures: { jsx: true } },
        globals: { ...globals.browser },
      },
      rules: jsxA11y.flatConfigs.strict.rules,
    },
    {
      name: 'ralysa/react-ui/design-system',
      files,
      ignores: TEST_FILES,
      plugins: { ralysa: ralysaPlugin, 'better-tailwindcss': betterTailwind, i18next },
      settings: {
        // tailwindcss is resolved next to the entry point, so a workspace that only lints with
        // the ui theme doesn't need its own tailwindcss dependency.
        'better-tailwindcss': {
          entryPoint: tailwindEntryPoint,
          cwd: dirname(tailwindEntryPoint),
        },
      },
      rules: {
        'ralysa/no-raw-color': 'error',
        'ralysa/no-physical-inline-style': 'error',
        'better-tailwindcss/enforce-logical-properties': ['error', { ignore: LOGICAL_IGNORE }],
        'better-tailwindcss/no-restricted-classes': ['error', { restrict: RESTRICTED_CLASSES }],
        'better-tailwindcss/no-unknown-classes': 'error',
        // JSX text and string children. Attributes are left to ralysa/no-literal-attribute-text,
        // because this plugin treats most attributes of native DOM elements as safe. Only
        // strings without a letter are exempt (the plugin's default also exempts ALL-CAPS text).
        'i18next/no-literal-string': [
          'error',
          {
            mode: 'jsx-only',
            'jsx-attributes': { exclude: ['.*'] },
            words: { exclude: [/^[^\p{L}]*$/u] },
            'should-validate-template': true,
            message:
              'User-visible text must come from an i18n key, e.g. t("ns:area.element") (AC-5). Literal',
          },
        ],
        'ralysa/no-literal-attribute-text': ['error', { attributes: USER_VISIBLE_ATTRIBUTES }],
        'ralysa/no-unpaired-direction-variant': 'error',
        // Base's boundary selectors plus the UI one. A flat-config rule entry replaces earlier
        // options, so the base entries are merged in through boundaryRules(), never dropped.
        'no-restricted-syntax': boundaryRules({ syntax: UI_RESTRICTED_SYNTAX })[
          'no-restricted-syntax'
        ],
      },
    },
    // base() drops the loading ban for reviewed LOADING_EXCEPTIONS files. The block above comes
    // later and would re-enable it there, so repeat the exception: keep only the UI selector.
    ...loadingExceptionBlocks(workspace),
  ];
}

/**
 * @param {string | undefined} workspace
 * @returns {import('eslint').Linter.Config[]}
 */
function loadingExceptionBlocks(workspace) {
  if (workspace === undefined) return [];
  return LOADING_EXCEPTIONS.flatMap((exception) => {
    const files = exception.files
      .map((glob) => workspaceGlob(glob, workspace))
      .filter((glob) => glob !== undefined);
    if (files.length === 0) return [];
    return [
      {
        name: `ralysa/react-ui/loading-exception/${exception.files.join(',')}`,
        files,
        ignores: TEST_FILES,
        rules: { 'no-restricted-syntax': ['error', ...UI_RESTRICTED_SYNTAX] },
      },
    ];
  });
}
