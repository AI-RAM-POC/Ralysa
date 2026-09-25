// cp / 0005: the governance feed's epoch and the session purge (F-002-T08; §3.2.6, §3.4.3, §4.4).
// - cp.governance_epoch_seq: a sequence that every revocation (session, user, kill switch)
//   advances in the same transaction. The feed reports its last value, so `epoch` never
//   decreases and changes on every change [SEC-F002-18].
// - ralysa_cp_app may DELETE ended sessions after 30 days (the cleanup job; T05-9 deferred it).
import type { Kysely } from 'kysely';
import { exec } from '../ddl.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await exec(db, [
    `CREATE SEQUENCE cp.governance_epoch_seq AS bigint MINVALUE 1 NO CYCLE`,
    `REVOKE ALL ON SEQUENCE cp.governance_epoch_seq FROM PUBLIC`,
    `GRANT USAGE, SELECT ON SEQUENCE cp.governance_epoch_seq TO ralysa_cp_app`,
    `GRANT DELETE ON cp.auth_session TO ralysa_cp_app`,
  ]);
}
