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
import { JS_FILES } from './base.js';
import { ralysaPlugin } from './rules/index.js';
import { LOGICAL_IGNORE, NO_THEME_ENTRY_POINT, RESTRICTED_CLASSES } from './tailwind.js';
import { TEST_FILES } from './tests.js';

export const UI_FILES = ['**/*.{js,mjs,jsx,ts,tsx}'];

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
 * }} [options] `tailwindEntryPoint` is the absolute path of the workspace's Tailwind CSS entry
 *   point, normally `fileURLToPath(import.meta.resolve('@ralysa/ui/tailwind.css'))`. Without it,
 *   every token-backed class is reported as unknown.
 * @returns {import('eslint').Linter.Config[]}
 */
export function reactUi({ files = UI_FILES, tailwindEntryPoint = NO_THEME_ENTRY_POINT } = {}) {
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
      },
    },
  ];
}
