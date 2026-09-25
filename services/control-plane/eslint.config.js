import { base, boundaryRules, tests } from '@ralysa/eslint-config';

// SEC-F002-31: application code reaches org data only through withOrg() (a transaction-local
// set_config). A session-level `SET ROLE`, `SET app.…` or set_config('app.org_id', …, false)
// would outlive the request on a pooled connection. The migrate job's single-connection pool
// (src/db/migrate.ts) is the one reviewed exception.
const message =
  'Session-level role or app.* settings are banned outside src/db/migrate.ts (SEC-F002-31); use withOrg()';
const SESSION_SETTING = String.raw`/\bSET\s+(SESSION\s+)?(ROLE|app\.)|set_config\(\s*'app\.[a-z_]+'\s*,[^)]*,\s*false\s*\)/i`;
const DB_SESSION_SYNTAX = [
  { selector: `Literal[value=${SESSION_SETTING}]`, message },
  { selector: `TemplateElement[value.raw=${SESSION_SETTING}]`, message },
];

/** @type {import('eslint').Linter.Config[]} */
const config = [
  ...base({ tsconfigRootDir: import.meta.dirname }),
  ...tests(),
  {
    name: 'control-plane/db-session-settings',
    files: ['src/**/*.ts'],
    ignores: ['src/db/migrate.ts'],
    rules: {
      'no-restricted-syntax': boundaryRules({ syntax: DB_SESSION_SYNTAX })['no-restricted-syntax'],
    },
  },
];

export default config;
