// The `base` preset applies to every JS/TS file in every workspace: source, tests, scripts and
// *.config.* files. It holds the boundary rules and the lint-comment rules (F-001 design §6.1,
// RC-3), so no other preset has to repeat them and none may relax them.
import js from '@eslint/js';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import {
  BANNED_IMPORT_PATHS,
  BANNED_IMPORT_PATTERNS,
  BOUNDARY_RULE_IDS,
  RESTRICTED_SYNTAX,
} from './boundaries.js';

export const ALL_FILES = ['**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}'];
export const JS_FILES = ['**/*.{js,cjs,mjs,jsx}'];

/**
 * Builds the boundary rule entries. Presets that add restrictions (for example `isomorphic`)
 * call this with extras instead of redefining the rules, because a flat-config rule entry
 * replaces the earlier entry's options rather than merging them.
 * @param {{
 *   paths?: import('./boundaries.js').RestrictedPath[],
 *   patterns?: import('./boundaries.js').RestrictedPattern[],
 *   syntax?: import('./boundaries.js').RestrictedSyntax[],
 * }} [extra]
 * @returns {import('eslint').Linter.RulesRecord}
 */
export function boundaryRules(extra = {}) {
  return {
    'no-restricted-imports': [
      'error',
      {
        paths: [...BANNED_IMPORT_PATHS, ...(extra.paths ?? [])],
        patterns: [...BANNED_IMPORT_PATTERNS, ...(extra.patterns ?? [])],
      },
    ],
    'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX, ...(extra.syntax ?? [])],
  };
}

/**
 * @param {{ tsconfigRootDir: string }} options the workspace directory (`import.meta.dirname`)
 * @returns {import('eslint').Linter.Config[]}
 */
export function base({ tsconfigRootDir }) {
  return [
    {
      name: 'ralysa/base/ignores',
      ignores: ['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/.tsc/**', '**/node_modules/**'],
    },
    {
      name: 'ralysa/base/linter-options',
      linterOptions: {
        reportUnusedDisableDirectives: 'error',
        reportUnusedInlineConfigs: 'error',
      },
    },
    { ...js.configs.recommended, name: 'ralysa/base/eslint-recommended', files: ALL_FILES },
    ...tseslint.configs.strictTypeChecked.map((config) => ({ ...config, files: ALL_FILES })),
    {
      name: 'ralysa/base/type-info',
      files: ALL_FILES,
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
      },
    },
    {
      ...tseslint.configs.disableTypeChecked,
      name: 'ralysa/base/js-without-type-info',
      files: JS_FILES,
    },
    {
      name: 'ralysa/base/js-globals',
      files: JS_FILES,
      languageOptions: { globals: { ...globals.node } },
    },
    { ...comments.recommended, name: 'ralysa/base/eslint-comments', files: ALL_FILES },
    {
      name: 'ralysa/base/rules',
      files: ALL_FILES,
      rules: {
        eqeqeq: ['error', 'always'],
        'no-console': 'off',
        '@typescript-eslint/consistent-type-imports': 'error',
        // Lint-disable comments can't switch the boundary layer off (SEC-F001-09 f).
        '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
        '@eslint-community/eslint-comments/no-restricted-disable': ['error', ...BOUNDARY_RULE_IDS],
        '@eslint-community/eslint-comments/no-use': [
          'error',
          { allow: ['eslint-disable-next-line'] },
        ],
        '@eslint-community/eslint-comments/require-description': 'error',
        '@eslint-community/eslint-comments/no-unused-disable': 'error',
        ...boundaryRules(),
      },
    },
  ];
}
