// Sessions, refresh-token families, revocation and authorization-code tombstones (F-002 design
// §3.2.3, §3.2.6, §3.3; SEC-F002-17, -18, -20). Every function runs inside the caller's withOrg
// transaction; timestamps come from the database clock.
//
// - A session (`sid`) is the refresh-token family. Rotation is ONE statement guarded by
//   `status = 'active'`, so two concurrent refreshes can't both succeed.
// - Revocation sets auth_session.revoked_at or app_user.revoked_before (DB clock + 30 s skew) and
//   advances cp.governance_epoch_seq in the same transaction, so the feed's epoch never
//   decreases and changes with every revocation.
// - An authorization code is consumed with one UPDATE … WHERE used_at IS NULL and kept as a
//   tombstone until expiry + 1 h; a second redemption revokes the session it created.
import { type Transaction, sql } from 'kysely';
import type { Database } from '../db/types.js';
import { newRefreshToken, tokenHash } from './tokens/opaque.js';
import { uuidv7 } from '@ralysa/protocol/common';

type Trx = Transaction<Database>;
export type SessionRole = 'user' | 'platform_admin';

/**
 * The governance feed's cursor lags its read time by CURSOR_OVERLAP_S (60 s) so a revocation
 * stamped before a poll but committed after it is still delivered. That holds only while no
 * revocation transaction stays open longer than the overlap, so every revocation statement first
 * caps its transaction at REVOCATION_TX_TIMEOUT_S (Postgres 17 `transaction_timeout`; the timer
 * starts when it is set, so it bounds stamp-to-commit). It is set once per transaction: later
 * revocations in the same transaction don't restart it. A transaction that runs out is terminated
 * and nothing is revoked; the caller answers an error and the client retries (review of #26).
 */
export const REVOCATION_TX_TIMEOUT_S = 15;

export async function limitRevocationTransaction(trx: Trx): Promise<void> {
  await sql`select set_config('transaction_timeout', ${`${String(REVOCATION_TX_TIMEOUT_S)}s`}, true)
             where current_setting('transaction_timeout') in ('0', '0ms')`.execute(trx);
}

export async function bumpEpoch(trx: Trx): Promise<void> {
  await sql`select nextval('cp.governance_epoch_seq')`.execute(trx);
}

export interface NewSession {
  orgId: string;
  userId: string;
  clientId: string;
  surface: string;
  flow: 'idp_device' | 'loopback_pkce';
  status: 'pending' | 'active';
  roles: SessionRole[];
  deviceLabel?: string | null;
  createdIp?: string | null;
  absoluteSeconds: number;
}

export async function createSession(trx: Trx, session: NewSession): Promise<string> {
  const id = uuidv7();
  await trx
    .insertInto('cp.auth_session')
    .values({
      id,
      org_id: session.orgId,
      user_id: session.userId,
      client_id: session.clientId,
      surface: session.surface,
      flow: session.flow,
      status: session.status,
      roles: session.roles,
      device_label: session.deviceLabel ?? null,
      created_ip: session.createdIp ?? null,
      absolute_expires_at: sql<Date>`clock_timestamp() + make_interval(secs => ${session.absoluteSeconds})`,
    })
    .execute();
  return id;
}

/** Issues a refresh token in the family; returns the token (only its hash is stored). */
export async function issueRefreshToken(
  trx: Trx,
  input: { orgId: string; sessionId: string; parentId: string | null; idleSeconds: number },
): Promise<{ id: string; token: string }> {
  const token = newRefreshToken();
  const id = uuidv7();
  await trx
    .insertInto('cp.refresh_token')
    .values({
      id,
      org_id: input.orgId,
      session_id: input.sessionId,
      parent_id: input.parentId,
      token_hash: tokenHash(token),
      status: 'active',
      expires_at: sql<Date>`least(
        clock_timestamp() + make_interval(secs => ${input.idleSeconds}),
        (select absolute_expires_at from cp.auth_session where id = ${input.sessionId}))`,
    })
    .execute();
  return { id, token };
}

export interface RefreshTokenView {
  tokenId: string;
  tokenStatus: 'active' | 'rotated' | 'revoked';
  tokenExpired: boolean;
  sessionId: string;
  sessionStatus: 'pending' | 'active' | 'revoked';
  sessionExpired: boolean;
  sessionCreatedAt: Date;
  roles: SessionRole[];
  clientId: string;
  surface: string;
  flow: 'idp_device' | 'loopback_pkce';
  userId: string;
  idpSubject: string;
  idpTenantId: string;
  userStatus: 'active' | 'disabled';
}

export async function findRefreshToken(
  trx: Trx,
  token: string,
): Promise<RefreshTokenView | undefined> {
  const row = await trx
    .selectFrom('cp.refresh_token as t')
    .innerJoin('cp.auth_session as s', 's.id', 't.session_id')
    .innerJoin('cp.app_user as u', 'u.id', 's.user_id')
    .select([
      't.id as tokenId',
      't.status as tokenStatus',
      sql<boolean>`t.expires_at <= clock_timestamp()`.as('tokenExpired'),
      's.id as sessionId',
      's.status as sessionStatus',
      sql<boolean>`s.absolute_expires_at <= clock_timestamp()`.as('sessionExpired'),
      's.created_at as sessionCreatedAt',
      's.roles as roles',
      's.client_id as clientId',
      's.surface as surface',
      's.flow as flow',
      'u.id as userId',
      'u.idp_subject as idpSubject',
      'u.idp_tenant_id as idpTenantId',
      'u.status as userStatus',
    ])
    .where('t.token_hash', '=', tokenHash(token))
    .executeTakeFirst();
  return row;
}

/** The one-statement rotation guard: true only for the single caller that rotated it. */
export async function markRotated(trx: Trx, tokenId: string): Promise<boolean> {
  const rotated = await trx
    .updateTable('cp.refresh_token')
    .set({ status: 'rotated', used_at: sql<Date>`clock_timestamp()` })
    .where('id', '=', tokenId)
    .where('status', '=', 'active')
    .where(sql<boolean>`expires_at > clock_timestamp()`)
    .returning('id')
    .executeTakeFirst();
  return rotated !== undefined;
}

/** Revokes a session and all its refresh tokens. Returns whether it was active before. */
export async function revokeSession(trx: Trx, sessionId: string, reason: string): Promise<boolean> {
  await limitRevocationTransaction(trx);
  const changed = await trx
    .updateTable('cp.auth_session')
    .set({ status: 'revoked', revoked_at: sql<Date>`clock_timestamp()`, revoked_reason: reason })
    .where('id', '=', sessionId)
    .where('status', '!=', 'revoked')
    .returning('id')
    .executeTakeFirst();
  const tokens = await trx
    .updateTable('cp.refresh_token')
    .set({ status: 'revoked' })
    .where('session_id', '=', sessionId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (changed !== undefined || Number(tokens.numUpdatedRows) > 0) await bumpEpoch(trx);
  return changed !== undefined;
}

/**
 * Revokes everything a user holds: every live session, and every access token issued before
 * now + 30 s (revoked_before, DB clock + verifier skew) [SEC-F002-18 c]. Optionally disables.
 */
export async function revokeUser(
  trx: Trx,
  userId: string,
  reason: string,
  options: { disable?: boolean } = {},
): Promise<number> {
  await limitRevocationTransaction(trx);
  await trx
    .updateTable('cp.app_user')
    .set({
      revoked_before: sql<Date>`clock_timestamp() + interval '30 seconds'`,
      updated_at: sql<Date>`clock_timestamp()`,
      ...(options.disable === true ? { status: 'disabled' as const } : {}),
    })
    .where('id', '=', userId)
    .execute();
  const sessions = await trx
    .selectFrom('cp.auth_session')
    .select('id')
    .where('user_id', '=', userId)
    .where('status', '!=', 'revoked')
    .execute();
  for (const session of sessions) await revokeSession(trx, session.id, reason);
  await bumpEpoch(trx);
  return sessions.length;
}

export type CodeRedemption =
  | {
      kind: 'ok';
      sessionId: string;
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      callbackIp: string | null;
      /** Facts from the IdP callback (cp/0006). */
      signIn: Record<string, unknown>;
    }
  | { kind: 'reused'; sessionId: string; revoked: boolean }
  /** A live code presented with another client, redirect URI or PKCE challenge: not consumed. */
  | { kind: 'mismatch' }
  | { kind: 'invalid' };

/** What a redemption must match: the client, the exact redirect URI and the PKCE challenge. */
export interface CodeBinding {
  clientId: string;
  redirectUri: string;
  /** S256(code_verifier), base64url. */
  codeChallenge: string;
}

/**
 * Consumes an authorization code once [SEC-F002-20]. The row stays as a tombstone (used_at set)
 * until expiry + 1 h; a second redemption revokes the session the first one created. Expired or
 * unknown codes are `invalid`. With a `binding`, only a matching redemption consumes the code
 * (one UPDATE); a live code presented with another client, redirect URI or verifier is a
 * `mismatch` and stays redeemable by its owner (RFC 6749 §4.1.3, RFC 7636 §4.6).
 */
export async function redeemAuthorizationCode(
  trx: Trx,
  code: string,
  binding?: CodeBinding,
): Promise<CodeRedemption> {
  const hash = tokenHash(code);
  let update = trx
    .updateTable('cp.authorization_code')
    .set({ used_at: sql<Date>`clock_timestamp()` })
    .where('code_hash', '=', hash)
    .where('used_at', 'is', null)
    .where(sql<boolean>`expires_at > clock_timestamp()`);
  if (binding !== undefined) {
    update = update
      .where('client_id', '=', binding.clientId)
      .where('redirect_uri', '=', binding.redirectUri)
      .where('code_challenge', '=', binding.codeChallenge);
  }
  const consumed = await update
    .returning([
      'session_id',
      'client_id',
      'redirect_uri',
      'code_challenge',
      'callback_ip',
      'sign_in',
    ])
    .executeTakeFirst();
  if (consumed !== undefined) {
    return {
      kind: 'ok',
      sessionId: consumed.session_id,
      clientId: consumed.client_id,
      redirectUri: consumed.redirect_uri,
      codeChallenge: consumed.code_challenge,
      callbackIp: consumed.callback_ip,
      signIn: consumed.sign_in,
    };
  }
  const row = await trx
    .selectFrom('cp.authorization_code')
    .select(['session_id', 'used_at', sql<boolean>`expires_at > clock_timestamp()`.as('live')])
    .where('code_hash', '=', hash)
    .executeTakeFirst();
  if (row?.used_at !== null && row?.used_at !== undefined) {
    const revoked = await revokeSession(trx, row.session_id, 'reuse_detected');
    return { kind: 'reused', sessionId: row.session_id, revoked };
  }
  if (row !== undefined && row.live && binding !== undefined) return { kind: 'mismatch' };
  return { kind: 'invalid' };
}

/** Stores a new authorization code (hash only) bound to its session, client and challenge. */
export async function createAuthorizationCode(
  trx: Trx,
  input: {
    orgId: string;
    code: string;
    sessionId: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    callbackIp: string | null;
    ttlSeconds: number;
    signIn: Record<string, unknown>;
  },
): Promise<void> {
  await trx
    .insertInto('cp.authorization_code')
    .values({
      code_hash: tokenHash(input.code),
      org_id: input.orgId,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      session_id: input.sessionId,
      callback_ip: input.callbackIp,
      expires_at: sql<Date>`clock_timestamp() + make_interval(secs => ${input.ttlSeconds})`,
      used_at: null,
      sign_in: JSON.stringify(input.signIn),
    })
    .execute();
}

/**
 * Activates a pending session (flow B at code redemption) and issues its first refresh token.
 * Undefined when the session is no longer pending (revoked meanwhile).
 */
export async function activatePendingSession(
  trx: Trx,
  input: { orgId: string; sessionId: string; idleSeconds: number },
): Promise<{ id: string; token: string } | undefined> {
  const activated = await trx
    .updateTable('cp.auth_session')
    .set({ status: 'active' })
    .where('id', '=', input.sessionId)
    .where('status', '=', 'pending')
    .where(sql<boolean>`absolute_expires_at > clock_timestamp()`)
    .returning('id')
    .executeTakeFirst();
  if (activated === undefined) return undefined;
  return issueRefreshToken(trx, {
    orgId: input.orgId,
    sessionId: input.sessionId,
    parentId: null,
    idleSeconds: input.idleSeconds,
  });
}
