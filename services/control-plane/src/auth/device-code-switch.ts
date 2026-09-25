// The tenant's device-code switch (F-002 design §3.2.5, §3.8; D-30; SEC-F002-32). In Phase 0 the
// deployment config is authoritative (`access.device_code_enabled`, copied into
// organization.settings at start). While it is off:
//   - the token-exchange grant answers unauthorized_client (token-exchange.ts), and
//   - every live flow-A session (`flow = idp_device`, active or pending) is revoked with
//     `auth.session.revoked cause=device_code_disabled`, so switching it off also ends the
//     sessions device code already created.
// `serve` runs this at start; it is idempotent, so running it on every start with the switch off
// also covers a change made while the service was down. (There is no live config reload in Phase
// 0: a config change is a restart.) F-018 makes the database authoritative.
import { newTraceId } from '@ralysa/protocol/common';
import type { Kysely } from 'kysely';
import type { AuditWriter } from '../audit/writer.js';
import { withOrg } from '../db/kysely.js';
import type { Database } from '../db/types.js';
import { authEvent } from './audit-events.js';
import { revokeSession } from './sessions.js';

export const SWITCH_BATCH = 200;

export async function revokeDeviceCodeSessions(deps: {
  db: Kysely<Database>;
  orgId: string;
  writer: AuditWriter;
  batch?: number;
}): Promise<number> {
  const batch = deps.batch ?? SWITCH_BATCH;
  const traceId = newTraceId();
  let total = 0;
  for (;;) {
    const revoked = await withOrg(deps.db, deps.orgId, async (trx) => {
      const live = await trx
        .selectFrom('cp.auth_session as s')
        .innerJoin('cp.app_user as u', 'u.id', 's.user_id')
        .select(['s.id as sid', 'u.id as userId', 'u.idp_subject as idpSubject'])
        .where('s.flow', '=', 'idp_device')
        .where('s.status', '!=', 'revoked')
        .limit(batch)
        .forUpdate()
        .skipLocked()
        .execute();
      const changed = [];
      for (const row of live) {
        if (await revokeSession(trx, row.sid, 'device_code_disabled')) changed.push(row);
      }
      return changed;
    });
    if (revoked.length > 0) {
      await deps.writer.writeOrSpool(
        deps.orgId,
        revoked.map((row) =>
          authEvent({
            action: 'auth.session.revoked',
            outcome: 'success',
            traceId,
            user: { id: row.userId, idpSubject: row.idpSubject },
            sessionId: row.sid,
            details: { sid: row.sid, revoked_by: 'system', cause: 'device_code_disabled' },
          }),
        ),
      );
    }
    total += revoked.length;
    if (revoked.length < batch) return total;
  }
}
