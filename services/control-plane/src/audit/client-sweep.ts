// The client-session sweep (F-002 design §3.4.5; [AR-14], SEC-F002-14), run by `serve` on a timer:
//
// - a session whose open `client_seq` gaps have seen no event for 15 minutes: each range becomes
//   final as one `audit.client_seq_gap` (cause `idle`), and the cursor's open gaps are cleared
//   (a later event inside one is then a 409, like any other seq ≤ last);
// - a session with no `session.ended` and no event for 24 hours: its remaining gaps are recorded,
//   then `audit.client_session_unterminated` with the last seq, and the cursor is closed.
//
// Idleness is measured on the database clock from the cursor's `updated_at`, so a long-running
// but active session is never flagged. Each pass takes at most `batch` cursors with
// FOR UPDATE SKIP LOCKED, so replicas share the work, and writes the events fail-closed before
// the cursors change: if the write fails, nothing changes and the next pass retries. The event
// ids are derived from the session (and range), so a retry after an ambiguous write is a
// duplicate, never a second event.
import {
  CLIENT_GAP_FINAL_AFTER_MS,
  CLIENT_SESSION_UNTERMINATED_AFTER_MS,
} from '@ralysa/protocol/control-plane';
import { type Kysely, sql } from 'kysely';
import { withOrg } from '../db/kysely.js';
import type { Database } from '../db/types.js';
import {
  clientSeqGapEvent,
  clientSessionUnterminatedEvent,
  parseMultirange,
} from './client-sessions.js';
import type { StoredEventInput } from './columns.js';
import type { AuditWriter } from './writer.js';

export const CLIENT_SWEEP_INTERVAL_MS = 60_000;

export interface ClientSweepResult {
  gapsFinalised: number;
  unterminated: number;
}

export async function sweepClientSessions(options: {
  db: Kysely<Database>;
  orgId: string;
  writer: AuditWriter;
  batch?: number;
}): Promise<ClientSweepResult> {
  const gapAfter = `${String(CLIENT_GAP_FINAL_AFTER_MS / 1000)} seconds`;
  const openAfter = `${String(CLIENT_SESSION_UNTERMINATED_AFTER_MS / 1000)} seconds`;
  return withOrg(options.db, options.orgId, async (trx) => {
    const rows = await trx
      .selectFrom('cp.client_audit_cursor as c')
      .innerJoin('cp.app_user as u', 'u.id', 'c.user_id')
      .select([
        'c.user_id',
        'c.session_id',
        'c.last_seq',
        'c.open_gaps',
        'u.idp_subject',
        sql<boolean>`c.updated_at < clock_timestamp() - ${openAfter}::interval`.as('unterminated'),
      ])
      .where('c.ended_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb.and([
            eb('c.open_gaps', '!=', '{}'),
            sql<boolean>`c.updated_at < clock_timestamp() - ${gapAfter}::interval`,
          ]),
          sql<boolean>`c.updated_at < clock_timestamp() - ${openAfter}::interval`,
        ]),
      )
      .orderBy('c.updated_at')
      .limit(options.batch ?? 100)
      .forUpdate('c')
      .skipLocked()
      .execute();
    if (rows.length === 0) return { gapsFinalised: 0, unterminated: 0 };

    const events: StoredEventInput[] = [];
    let gapsFinalised = 0;
    let unterminated = 0;
    for (const row of rows) {
      const owner = {
        orgId: options.orgId,
        userId: row.user_id,
        idpSubject: row.idp_subject,
        sessionId: row.session_id,
      };
      for (const gap of parseMultirange(row.open_gaps)) {
        events.push(clientSeqGapEvent(owner, gap, row.unterminated ? 'unterminated' : 'idle'));
        gapsFinalised++;
      }
      if (row.unterminated) {
        events.push(clientSessionUnterminatedEvent(owner, Number(row.last_seq)));
        unterminated++;
      }
    }
    await options.writer.write(options.orgId, events);
    for (const row of rows) {
      await trx
        .updateTable('cp.client_audit_cursor')
        .set({
          open_gaps: '{}',
          ...(row.unterminated ? { ended_at: sql`now()` } : {}),
        })
        .where('user_id', '=', row.user_id)
        .where('session_id', '=', row.session_id)
        .execute();
    }
    return { gapsFinalised, unterminated };
  });
}
