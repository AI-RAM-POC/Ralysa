// The SEC-F002-31 lint ban is on for all application source and off only for the migrate job
// (the rule's behaviour itself is tested in tooling/eslint-config).
import { ESLint } from 'eslint';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root });
const severity = async (file: string) =>
  ((await eslint.calculateConfigForFile(join(root, file))) as { rules?: Record<string, unknown> })
    .rules?.['ralysa/no-session-db-settings'];

// The first typed ESLint config load takes ~10 s on CI runners.
describe('control-plane lint config (SEC-F002-31)', { timeout: 60_000 }, () => {
  it.each(['src/db/kysely.ts', 'src/audit/writer.ts', 'src/main.ts', 'src/config/load.ts'])(
    'bans session-level settings in %s',
    async (file) => {
      expect(await severity(file)).toEqual([2]);
    },
  );

  it('exempts only src/db/migrate.ts', async () => {
    expect(await severity('src/db/migrate.ts')).toBeUndefined();
  });

  it('flags the tagged-template false form in application code', async () => {
    const [result] = await eslint.lintText(
      "import { sql } from 'kysely';\nexport const q = (org: string) => sql`select set_config('app.org_id', ${org}, false)`;\n",
      { filePath: join(root, 'src/db/kysely.ts') },
    );
    expect(result?.messages.map((m) => m.ruleId)).toContain('ralysa/no-session-db-settings');
  });
});
