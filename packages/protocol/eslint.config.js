import { base, isomorphic, tests } from '@ralysa/eslint-config';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  ...base({ tsconfigRootDir: import.meta.dirname }),
  // The package and its tests are isomorphic; scripts/ is Node tooling (check:generated) that
  // is never shipped or imported by src/.
  ...isomorphic({ files: ['src/**', 'test/**', '*.config.ts'] }),
  ...tests(),
];

export default config;
