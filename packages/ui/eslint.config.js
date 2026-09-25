import { base, reactUi, tests } from '@ralysa/eslint-config';

/** @type {import('eslint').Linter.Config[]} */
const config = [...base({ tsconfigRootDir: import.meta.dirname }), ...reactUi(), ...tests()];

export default config;
