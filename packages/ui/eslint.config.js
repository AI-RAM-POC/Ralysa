import { base, reactUi, tests } from '@ralysa/eslint-config';
import { fileURLToPath } from 'node:url';

// Tailwind class rules lint against this package's own entry point (token-backed theme).
const tailwindEntryPoint = fileURLToPath(new URL('./src/styles/tailwind.css', import.meta.url));

/** @type {import('eslint').Linter.Config[]} */
const config = [
  ...base({ tsconfigRootDir: import.meta.dirname }),
  ...reactUi({ tailwindEntryPoint }),
  ...tests(),
];

export default config;
