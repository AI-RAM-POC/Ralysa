// ralysa/no-session-db-settings (F-002 SEC-F002-31, code review of PR #19): session-level role,
// authorization and app.* settings are banned in string literals AND whole template literals,
// including Kysely's tagged sql`…` where an interpolation splits the text.
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { findSessionSetting, noSessionDbSettings } from '../rules/no-session-db-settings.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const banned = { messageId: 'banned' } as const;

ruleTester.run('ralysa/no-session-db-settings', noSessionDbSettings, {
  valid: [
    // withOrg's own form: transaction-local.
    "sql`select set_config('app.org_id', ${orgId}, true)`;",
    'const q = "select set_config(\'app.org_id\', $1, true)";',
    "sql`select set_config('app.org_id', ${orgId}, TRUE)`;",
    // Other settings are not identity or org.
    "sql`select set_config('statement_timeout', ${ms}, true)`;",
    "sql`select set_config('statement_timeout', '250ms', false)`;",
    "const q = 'select current_setting($1)';",
    "const doc = 'reset the settings when done';",
    'sql`select 1 from cp.organization where id = ${id}`;',
  ],
  invalid: [
    // The case the first version missed: the tagged template splits around ${}.
    { code: "sql`select set_config('app.org_id', ${org}, false)`;", errors: [banned] },
    { code: "db.query(`select set_config('app.org_id', ${org}, false)`);", errors: [banned] },
    { code: 'const q = "select set_config(\'app.org_id\', $1, false)";', errors: [banned] },
    { code: "sql`select set_config('app.org_id', ${org}, ${local})`;", errors: [banned] },
    { code: "sql`select set_config('app.org_id', ${org})`;", errors: [banned] },
    { code: "sql`select set_config( 'app.tenant' , ${x} , false )`;", errors: [banned] },
    {
      code: "const q = \"select set_config('role', 'ralysa_audit_owner', false)\";",
      errors: [banned],
    },
    { code: "sql`select set_config('role', ${r}, true)`;", errors: [banned] },
    {
      code: "const q = \"select set_config('session_authorization', 'x', true)\";",
      errors: [banned],
    },
    { code: "const q = 'SET ROLE ralysa_audit_owner';", errors: [banned] },
    { code: 'sql`set local role ${role}`;', errors: [banned] },
    { code: "const q = 'SET SESSION ROLE ralysa_cp_app';", errors: [banned] },
    { code: "const q = 'SET SESSION AUTHORIZATION ralysa_migrator';", errors: [banned] },
    { code: 'const q = `set session authorization ${who}`;', errors: [banned] },
    { code: "const q = 'set app.org_id = 1';", errors: [banned] },
    { code: "const q = 'SET LOCAL app.org_id = 1';", errors: [banned] },
  ],
});

describe('findSessionSetting', () => {
  it('reads the third argument past nested calls and quoted commas', () => {
    expect(
      findSessionSetting("select set_config('app.org_id', coalesce($1, 'a,b'), true)"),
    ).toBeUndefined();
    expect(
      findSessionSetting("select set_config('app.org_id', coalesce($1, 'a,b'), false)"),
    ).toMatch(/without is_local/);
  });
});
