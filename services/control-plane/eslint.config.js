import { base, ralysaPlugin, tests } from '@ralysa/eslint-config';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  ...base({ tsconfigRootDir: import.meta.dirname }),
  ...tests(),
  // SEC-F002-31: application code reaches org data only through withOrg() (transaction-local).
  // ralysa/no-session-db-settings reads string literals and whole (tagged) template literals.
  // The migrate job's single-connection pool (src/db/migrate.ts) is the one reviewed exception.
  {
    name: 'control-plane/db-session-settings',
    files: ['src/**/*.ts'],
    ignores: ['src/db/migrate.ts'],
    plugins: { ralysa: ralysaPlugin },
    rules: { 'ralysa/no-session-db-settings': 'error' },
  },
];

export default config;
