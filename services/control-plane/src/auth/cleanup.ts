// The session cleanup job (F-002 design §3.3, §4.4; SEC-F002-20; D-38). Runs every minute on
// every serve replica; each step is one statement per batch, so replicas never do the same row
// twice and every event is written exactly once.
//
// 1. Unredeemed authorization codes: a code that expired unused leaves its PENDING session. The
//    session is revoked (UPDATE … WHERE status = 'pending' RETURNING, so only one replica wins)
//    and `auth.sign_in failure code_not_redeemed` is written for it (D-38).
// 1b. A code that WAS redeemed but whose session is still pending well after the code expired
//    (RTS stopped between consuming the code and activating the session): the attempt never got
//    its event. The session is revoked and `auth.sign_in error internal_error` is written once,
//    with `details.cause = redemption_incomplete` (review of #30).
// 2. Expired rows are deleted: client-assertion and IdP-token replay keys at expiry,
//    idp_auth_request and authorization-code tombstones one hour after expiry [SEC-F002-20].
// 3. Ended sessions are purged 30 days after they end (revoked_at; else the earlier of the last
//    refresh token's idle expiry and the absolute expiry),
//    together with their refresh tokens. Tokens go with their session, not one by one, because
//    refresh_token.parent_id chains a family and a token can't outlive its parent row.
//
// Nothing here touches the governance feed: it covers the last 65 minutes, and a purged session
// ended 30 days ago.
import { newTraceId } from '@ralysa/protocol/common';
import { type Kysely, sql } from 'kysely';
import type { AuditWriter } from '../audit/writer.js';
import { withOrg } from '../db/kysely.js';
import type { Database } from '../db/types.js';
import { authEvent } from './audit-events.js';
import { bumpEpoch, limitRevocationTransaction } from './sessions.js';

export const CLEANUP_INTERVAL_MS = 60_000;
export const CLEANUP_BATCH = 500;
export const SESSION_RETENTION_DAYS = 30;
/** How long past a redeemed code's expiry a still-pending session counts as abandoned. */
export const REDEMPTION_GRACE_S = 300;

export interface CleanupDeps {
  db: Kysely<Database>;
  orgId: string;
  writer: AuditWriter;
  policyVersion: string;
}

export interface CleanupResult {
  codesNotRedeemed: number;
  redemptionsIncomplete: number;
  assertionReplays: number;
  idpTokenReplays: number;
  authRequests: number;
  codes: number;
  sessions: number;
  refreshTokens: number;
}

const count = (result: { numDeletedRows: bigint }[]): number =>
  result.reduce((n, r) => n + Number(r.numDeletedRows), 0);

export async function runCleanup(
  deps: CleanupDeps,
  options: { batch?: number } = {},
): Promise<CleanupResult> {
  const batch = options.batch ?? CLEANUP_BATCH;
  const { db, orgId } = deps;

  // 1. Pending sessions whose code expired unused.
  const abandoned = await withOrg(db, orgId, async (trx) => {
    await limitRevocationTransaction(trx);
    const rows = await trx
      .updateTable('cp.auth_session as s')
      .set({
        status: 'revoked',
        revoked_at: sql<Date>`clock_timestamp()`,
        revoked_reason: 'code_not_redeemed',
      })
      .from('cp.app_user as u')
      .whereRef('u.id', '=', 's.user_id')
      .where('s.status', '=', 'pending')
      // Only codes whose session is still pending, oldest first: a code already handled keeps
      // used_at null for another hour, and picking it again would starve newer ones (review of
      // #26, B3).
      .where('s.id', 'in', (eb) =>
        eb
          .selectFrom('cp.authorization_code as c')
          .innerJoin('cp.auth_session as p', 'p.id', 'c.session_id')
          .select('c.session_id')
          .where('c.used_at', 'is', null)
          .where('p.status', '=', 'pending')
          .where(sql<boolean>`c.expires_at <= clock_timestamp()`)
          .orderBy('c.expires_at')
          .limit(batch),
      )
      .returning(['s.id as sid', 's.flow', 'u.id as userId', 'u.idp_subject as idpSubject'])
      .execute();
    if (rows.length > 0) await bumpEpoch(trx);
    return rows;
  });
  if (abandoned.length > 0) {
    await deps.writer.writeOrSpool(
      orgId,
      abandoned.map((row) =>
        authEvent({
          action: 'auth.sign_in',
          outcome: 'failure',
          reasonCode: 'code_not_redeemed',
          traceId: newTraceId(),
          user: { id: row.userId, idpSubject: row.idpSubject },
          sessionId: row.sid,
          policyVersion: deps.policyVersion,
          details: { sid: row.sid, flow: row.flow, recorded_by: 'cleanup' },
        }),
      ),
    );
  }

  // 1b. Redeemed codes whose session never became active.
  const incomplete = await withOrg(db, orgId, async (trx) => {
    await limitRevocationTransaction(trx);
    const rows = await trx
      .updateTable('cp.auth_session as s')
      .set({
        status: 'revoked',
        revoked_at: sql<Date>`clock_timestamp()`,
        revoked_reason: 'redemption_incomplete',
      })
      .from('cp.app_user as u')
      .whereRef('u.id', '=', 's.user_id')
      .where('s.status', '=', 'pending')
      .where('s.id', 'in', (eb) =>
        eb
          .selectFrom('cp.authorization_code as c')
          .innerJoin('cp.auth_session as p', 'p.id', 'c.session_id')
          .select('c.session_id')
          .where('c.used_at', 'is not', null)
          .where('p.status', '=', 'pending')
          .where(
            sql<boolean>`c.expires_at + make_interval(secs => ${REDEMPTION_GRACE_S}) <= clock_timestamp()`,
          )
          .orderBy('c.expires_at')
          .limit(batch),
      )
      .returning(['s.id as sid', 's.flow', 'u.id as userId', 'u.idp_subject as idpSubject'])
      .execute();
    if (rows.length > 0) await bumpEpoch(trx);
    return rows;
  });
  if (incomplete.length > 0) {
    await deps.writer.writeOrSpool(
      orgId,
      incomplete.map((row) =>
        authEvent({
          action: 'auth.sign_in',
          outcome: 'error',
          reasonCode: 'internal_error',
          traceId: newTraceId(),
          user: { id: row.userId, idpSubject: row.idpSubject },
          sessionId: row.sid,
          policyVersion: deps.policyVersion,
          details: {
            sid: row.sid,
            flow: row.flow,
            recorded_by: 'cleanup',
            cause: 'redemption_incomplete',
          },
        }),
      ),
    );
  }

  // 2. Expired replay keys, auth requests and code tombstones.
  const deleted = await withOrg(db, orgId, async (trx) => {
    const assertion = await trx
      .deleteFrom('cp.client_assertion_replay')
      .where('jti_hash', 'in', (eb) =>
        eb
          .selectFrom('cp.client_assertion_replay')
          .select('jti_hash')
          .where(sql<boolean>`expires_at <= clock_timestamp()`)
          .limit(batch),
      )
      .execute();
    const idpToken = await trx
      .deleteFrom('cp.idp_token_replay')
      .where('token_id_hash', 'in', (eb) =>
        eb
          .selectFrom('cp.idp_token_replay')
          .select('token_id_hash')
          .where(sql<boolean>`expires_at <= clock_timestamp()`)
          .limit(batch),
      )
      .execute();
    const requests = await trx
      .deleteFrom('cp.idp_auth_request')
      .where('state_hash', 'in', (eb) =>
        eb
          .selectFrom('cp.idp_auth_request')
          .select('state_hash')
          .where(sql<boolean>`expires_at + interval '1 hour' <= clock_timestamp()`)
          .limit(batch),
      )
      .execute();
    const codes = await trx
      .deleteFrom('cp.authorization_code')
      .where('code_hash', 'in', (eb) =>
        eb
          .selectFrom('cp.authorization_code')
          .select('code_hash')
          .where(sql<boolean>`expires_at + interval '1 hour' <= clock_timestamp()`)
          .limit(batch),
      )
      .execute();
    return {
      assertionReplays: count(assertion),
      idpTokenReplays: count(idpToken),
      authRequests: count(requests),
      codes: count(codes),
    };
  });

  // 3. Sessions that ended more than 30 days ago, with their refresh tokens and codes.
  const purged = await withOrg(db, orgId, async (trx) => {
    const ended = await trx
      .selectFrom('cp.auth_session as s')
      .select('s.id')
      // A session ends when it is revoked, or when its last refresh token (idle) or its absolute
      // lifetime runs out, whichever is first (review of #26, item 4).
      .where(
        sql<boolean>`case when s.status = 'revoked' then s.revoked_at
          else least(s.absolute_expires_at,
            coalesce((select max(t.expires_at) from cp.refresh_token t where t.session_id = s.id),
                     s.absolute_expires_at))
          end + make_interval(days => ${SESSION_RETENTION_DAYS}) <= clock_timestamp()`,
      )
      .limit(batch)
      .forUpdate()
      .skipLocked()
      .execute();
    if (ended.length === 0) return { sessions: 0, refreshTokens: 0 };
    const ids = ended.map((s) => s.id);
    // One statement per family table: the parent_id chain is checked at statement end.
    const tokens = await trx
      .deleteFrom('cp.refresh_token')
      .where('session_id', 'in', ids)
      .execute();
    await trx.deleteFrom('cp.authorization_code').where('session_id', 'in', ids).execute();
    const sessions = await trx.deleteFrom('cp.auth_session').where('id', 'in', ids).execute();
    return { sessions: count(sessions), refreshTokens: count(tokens) };
  });

  return {
    codesNotRedeemed: abandoned.length,
    redemptionsIncomplete: incomplete.length,
    ...deleted,
    ...purged,
  };
}
