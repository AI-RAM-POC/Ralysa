import { base, reactUi, tests } from '@ralysa/eslint-config';
import { fileURLToPath } from 'node:url';

// Tailwind class rules lint against the Ralysa token theme.
const tailwindEntryPoint = fileURLToPath(import.meta.resolve('@ralysa/ui/tailwind.css'));

/** @type {import('eslint').Linter.Config[]} */
const config = [
  ...base({ tsconfigRootDir: import.meta.dirname }),
  ...reactUi({ workspaceDir: import.meta.dirname, tailwindEntryPoint }),
  ...tests(),
];

export default config;
