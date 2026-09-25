// cp / 0001: the operational schema and its RLS helper (F-002 design §4.1, §4.3). Runs as
// `ralysa_migrator`, which owns `cp` (and `ralysa_meta`, created by the migrator for its history).
// `public` is locked by bootstrap-roles.sql (the DBA owns it); this migration refuses to run if
// the app role could still create objects there.
import type { Kysely } from 'kysely';
import { currentOrgFunction, exec } from '../ddl.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await exec(db, [
    `DO $$
    BEGIN
      IF has_schema_privilege('ralysa_cp_app', 'public', 'CREATE') THEN
        RAISE EXCEPTION 'ralysa_cp_app can CREATE in schema public: run bootstrap-roles.sql first';
      END IF;
    END $$`,
    `CREATE SCHEMA cp`,
    `REVOKE ALL ON SCHEMA cp FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA cp TO ralysa_cp_app`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA cp REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
    currentOrgFunction('cp'),
    `REVOKE ALL ON FUNCTION cp.current_org() FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION cp.current_org() TO ralysa_cp_app`,
  ]);
}
