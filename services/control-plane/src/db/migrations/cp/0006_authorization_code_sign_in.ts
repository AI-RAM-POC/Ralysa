// cp / 0006: what flow B's code redemption needs to record the sign-in (F-002-T10; §3.3, D-38).
// `auth.sign_in success` is written when the code is redeemed, not at the IdP callback, so the
// facts the callback established (the IdP's `amr`/`acrs`/`ipaddr`, the roles, whether the admin
// role was withheld, the browser's user agent) travel with the code. No token, code or secret is
// ever stored here: the column is validated as an object and holds display facts only.
import type { Kysely } from 'kysely';
import { exec } from '../ddl.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await exec(db, [
    `ALTER TABLE cp.authorization_code
       ADD COLUMN sign_in jsonb NOT NULL DEFAULT '{}'::jsonb
       CHECK (jsonb_typeof(sign_in) = 'object' AND octet_length(sign_in::text) <= 4096)`,
  ]);
}
