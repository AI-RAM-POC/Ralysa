import { base, tests } from './index.js';

/** @type {import('eslint').Linter.Config[]} */
const config = [...base({ tsconfigRootDir: import.meta.dirname }), ...tests()];

export default config;
