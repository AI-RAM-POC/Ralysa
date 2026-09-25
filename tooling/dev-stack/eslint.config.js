import { base, tests } from '@ralysa/eslint-config';

/** @type {import('eslint').Linter.Config[]} */
const config = [...base({ tsconfigRootDir: import.meta.dirname }), ...tests()];

export default config;
