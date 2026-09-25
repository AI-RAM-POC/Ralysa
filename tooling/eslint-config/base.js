// The `base` preset applies to every JS/TS file in every workspace: source, tests, scripts and
// *.config.* files. It holds the boundary rules and the lint-comment rules (F-001 design §6.1,
// RC-3), so no other preset has to repeat them and none may relax them.
import js from '@eslint/js';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import globals from 'globals';
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import tseslint from 'typescript-eslint';
import {
  BANNED_IMPORT_PATHS,
  BANNED_IMPORT_PATTERNS,
  BANNED_PACKAGE_GROUPS,
  BOUNDARY_RULE_IDS,
  LOADING_EXCEPTIONS,
  RESTRICTED_SYNTAX,
  bannedImportPatterns,
  globSource,
} from './boundaries.js';

export const ALL_FILES = ['**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}'];
export const JS_FILES = ['**/*.{js,cjs,mjs,jsx}'];

/**
 * Builds the boundary rule entries. Presets that add restrictions (for example `isomorphic`)
 * call this with extras instead of redefining the rules, because a flat-config rule entry
 * replaces the earlier entry's options rather than merging them. `allow` lists the
 * BANNED_PACKAGE_GROUPS ids a file may import (only for the paths boundaries.js names).
 * @param {{
 *   paths?: import('./boundaries.js').RestrictedPath[],
 *   patterns?: import('./boundaries.js').RestrictedPattern[],
 *   syntax?: import('./boundaries.js').RestrictedSyntax[],
 *   allow?: string[],
 * }} [extra]
 * @returns {import('eslint').Linter.RulesRecord}
 */
export function boundaryRules(extra = {}) {
  return {
    'no-restricted-imports': [
      'error',
      {
        paths: [...BANNED_IMPORT_PATHS, ...(extra.paths ?? [])],
        patterns: [
          ...bannedImportPatterns(extra.allow),
          ...BANNED_IMPORT_PATTERNS,
          ...(extra.patterns ?? []),
        ],
      },
    ],
    'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX, ...(extra.syntax ?? [])],
  };
}

/**
 * The workspace folder (posix, relative to the repo root) that holds `dir`, or undefined when
 * no pnpm-workspace.yaml is above it.
 * @param {string} dir
 * @returns {string | undefined}
 */
function workspaceOf(dir) {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return relative(current, dir).split(sep).join('/');
    }
    if (dirname(current) === current) return undefined;
  }
}

/**
 * Turns a repo-relative glob from boundaries.js into one relative to `workspace` (the folder
 * the workspace's eslint.config.js resolves `files` from), or undefined if it doesn't apply.
 * @param {string} glob e.g. services/agent-host/src/engine/claude/**
 * @param {string} workspace e.g. services/agent-host
 * @returns {string | undefined}
 */
export function workspaceGlob(glob, workspace) {
  const segments = glob.split('/');
  const own = workspace.split('/');
  for (const [index, part] of own.entries()) {
    const segment = segments[index];
    if (segment === undefined) return undefined;
    if (segment === '**') return '**';
    if (!new RegExp(`^${globSource(segment)}$`).test(part)) return undefined;
  }
  const rest = segments.slice(own.length).join('/');
  return rest === '' ? '**' : rest;
}

/**
 * Config blocks for the reviewed boundary exceptions that fall inside this workspace: the
 * `importAllowedIn` paths of BANNED_PACKAGE_GROUPS, and LOADING_EXCEPTIONS. The rules stay at
 * `error`; only the allowed entries are dropped.
 * @param {string} workspace
 * @returns {import('eslint').Linter.Config[]}
 */
function boundaryExceptions(workspace) {
  /** @type {import('eslint').Linter.Config[]} */
  const blocks = [];
  const allowedGlobs = [...new Set(BANNED_PACKAGE_GROUPS.flatMap((g) => g.importAllowedIn))];
  for (const glob of allowedGlobs) {
    const local = workspaceGlob(glob, workspace);
    if (local === undefined) continue;
    const allow = BANNED_PACKAGE_GROUPS.filter((g) => g.importAllowedIn.includes(glob)).map(
      (g) => g.id,
    );
    blocks.push({
      name: `ralysa/base/boundary-allowed/${glob}`,
      files: [local],
      rules: { 'no-restricted-imports': boundaryRules({ allow })['no-restricted-imports'] },
    });
  }
  for (const exception of LOADING_EXCEPTIONS) {
    const files = exception.files
      .map((glob) => workspaceGlob(glob, workspace))
      .filter((glob) => glob !== undefined);
    if (files.length === 0) continue;
    blocks.push({
      name: `ralysa/base/loading-exception/${exception.files.join(',')}`,
      files,
      rules: { 'no-restricted-syntax': ['error'] },
    });
  }
  return blocks;
}

/**
 * @param {{ tsconfigRootDir: string, workspace?: string }} options `tsconfigRootDir` is the
 *   workspace directory (`import.meta.dirname`); `workspace` (repo-relative) is derived from it
 *   and only overridden by tests.
 * @returns {import('eslint').Linter.Config[]}
 */
export function base({ tsconfigRootDir, workspace = workspaceOf(tsconfigRootDir) }) {
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
    ...(workspace === undefined ? [] : boundaryExceptions(workspace)),
  ];
}
