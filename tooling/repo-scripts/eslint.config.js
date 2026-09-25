import { base, tests } from '@ralysa/eslint-config';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  { name: 'repo-scripts/ignores', ignores: ['templates/**'] },
  ...base({ tsconfigRootDir: import.meta.dirname }),
  ...tests(),
];

export default config;
