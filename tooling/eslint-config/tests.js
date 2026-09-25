// `tests` relaxes a few type-strictness rules in test files. It must never touch the boundary
// rules (BOUNDARY_RULE_IDS) or the lint-comment rules: a unit test composes the presets and
// asserts they are still `error` for test paths (RC-3, TC-F-001-29).
export const TEST_FILES = [
  '**/*.test.{js,mjs,jsx,ts,tsx}',
  '**/test/**/*.{js,mjs,jsx,ts,tsx}',
  '**/e2e/**/*.{js,mjs,jsx,ts,tsx}',
];

/**
 * @param {{ files?: string[] }} [options]
 * @returns {import('eslint').Linter.Config[]}
 */
export function tests({ files = TEST_FILES } = {}) {
  return [
    {
      name: 'ralysa/tests',
      files,
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
      },
    },
  ];
}
