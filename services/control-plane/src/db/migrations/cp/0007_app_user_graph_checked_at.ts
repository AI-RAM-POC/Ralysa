// cp / 0007: when Graph was last asked about a user's configured groups (F-002 design §4.4, rev 10;
// #47 review round 2, R58-4, SEC-F002-53). The refresh grant calls Graph outside any transaction
// and then writes the answer back to cp.group_membership. Two refreshes of one user can finish in
// the other order, so the write keeps the time its Graph call started here and skips an answer
// older than the stored one: a slow refresh can't re-add a membership a newer answer removed.
// Null until the first write-back after this migration.
import type { Kysely } from 'kysely';
import { exec } from '../ddl.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await exec(db, [`ALTER TABLE cp.app_user ADD COLUMN graph_checked_at timestamptz NULL`]);
}
