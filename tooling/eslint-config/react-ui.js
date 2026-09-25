// `react-ui` is the UI lint layer for React packages and apps: @eslint-react, the Rules of
// Hooks and jsx-a11y at `strict`. jsx-a11y 6.10.2 declares ESLint <= 9, so it is wrapped with
// @eslint/compat (F-001 design §2.2, §7.8; the T02 spike result is in implementation-notes.md).
// The logical-layout, raw-colour and literal-string rules join this preset in T06 to T08.
import eslintReact from '@eslint-react/eslint-plugin';
import { fixupPluginRules } from '@eslint/compat';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { JS_FILES } from './base.js';

export const UI_FILES = ['**/*.{js,mjs,jsx,ts,tsx}'];

const jsxA11yPlugin = fixupPluginRules(jsxA11y);

/**
 * @param {{ files?: string[] }} [options]
 * @returns {import('eslint').Linter.Config[]}
 */
export function reactUi({ files = UI_FILES } = {}) {
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
  ];
}
