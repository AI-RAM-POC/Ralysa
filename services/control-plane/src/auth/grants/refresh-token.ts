// The refresh_token grant (F-002 design §3.2.3, §5.3; AC-6, AC-8; SEC-F002-17, -18).
//
// 1. Look the token up by hash. A ROTATED token is reuse: the whole family is revoked,
//    auth.token.reuse_detected and auth.refresh denied reuse_detected are written, and the answer
//    is invalid_grant (no grace window, D-27). A revoked token or session, or an expired one, is
//    `revoked` / `expired`.
// 2. Re-check the user at the IdP directory (outside any transaction). Unavailable →
//    temporarily_unavailable and the token is NOT consumed. Disabled or deleted, Entra sessions
//    revoked after this session began, or in no configured group → the session (and for a
//    disabled user, the user) is revoked and the refresh denied.
// 3. Rotate with the one-statement guard. Losing the guard means another refresher presented
//    the same token first: under the one-refresher-per-device contract that is reuse too, so the
//    family is revoked and the loser gets invalid_grant [SEC-F002-17].
// 4. Issue the new refresh token and an access token for the requested audience. Audiences
//    other than control-plane require the session role `user` (§6.1).
import {
  CLI_CLIENT_ID,
  type RefreshReason,
  RefreshRequest,
  refreshI18nKey,
} from '@ralysa/protocol/auth';
import { uuidv7 } from '@ralysa/protocol/common';
import { sql } from 'kysely';
import { withOrg } from '../../db/kysely.js';
import { OAuthProblem } from '../../http/errors.js';
import { authEvent } from '../audit-events.js';
import type { RtsDeps } from '../deps.js';
import {
  type RefreshTokenView,
  type SessionRole,
  findRefreshToken,
  issueRefreshToken,
  markRotated,
  revokeSession,
  revokeUser,
} from '../sessions.js';
import { mintAccessToken } from '../tokens/mint.js';

export interface GrantContext {
  traceId: string;
  clientIp: string;
}

export interface TokenResult {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
}

function denied(reason: RefreshReason, description?: string): OAuthProblem {
  return new OAuthProblem(
    {
      error: reason === 'idp_unavailable' ? 'temporarily_unavailable' : 'invalid_grant',
      ...(description === undefined ? {} : { error_description: description }),
      ralysa_error: { code: reason, i18n_key: refreshI18nKey(reason) },
    },
    reason === 'idp_unavailable' ? 503 : 400,
  );
}

export async function refreshGrant(
  deps: RtsDeps,
  body: unknown,
  ctx: GrantContext,
): Promise<TokenResult> {
  const parsed = RefreshRequest.safeParse(body);
  if (!parsed.success) throw new OAuthProblem({ error: 'invalid_request' });
  const request = parsed.data;
  const audience = request.audience ?? 'control-plane';
  const orgId = deps.config.org.id;

  const record = async (
    view: RefreshTokenView,
    reason: RefreshReason,
    extra: Record<string, unknown> = {},
    revokedCause?: string,
  ) => {
    const outcome = reason === 'idp_unavailable' ? 'error' : 'denied';
    const user = { id: view.userId, idpSubject: view.idpSubject };
    await deps.writer.writeOrSpool(orgId, [
      // The revocation this denial caused, then the denial (§3.5: auth.session.revoked, cause).
      ...(revokedCause === undefined
        ? []
        : [
            authEvent({
              action: 'auth.session.revoked',
              outcome: 'success',
              traceId: ctx.traceId,
              user,
              sessionId: view.sessionId,
              details: {
                ...(revokedCause === 'not_in_access_group'
                  ? { sid: view.sessionId }
                  : { user_id: view.userId }),
                revoked_by: 'system',
                cause: revokedCause,
              },
            }),
          ]),
      authEvent({
        action: 'auth.refresh',
        outcome,
        reasonCode: reason,
        traceId: ctx.traceId,
        user,
        sessionId: view.sessionId,
        policyVersion: deps.policyVersion,
        details: { sid: view.sessionId, audience, client_ip: ctx.clientIp, ...extra },
      }),
    ]);
  };

  const reuse = async (view: RefreshTokenView): Promise<never> => {
    const revokedCount = await withOrg(deps.db, orgId, async (trx) => {
      const count = await trx
        .selectFrom('cp.refresh_token')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('session_id', '=', view.sessionId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      await revokeSession(trx, view.sessionId, 'reuse_detected');
      return count?.n ?? 0;
    });
    await deps.writer.writeOrSpool(orgId, [
      authEvent({
        action: 'auth.token.reuse_detected',
        outcome: 'denied',
        traceId: ctx.traceId,
        user: { id: view.userId, idpSubject: view.idpSubject },
        sessionId: view.sessionId,
        details: { sid: view.sessionId, revoked_count: revokedCount, token_kind: 'refresh' },
      }),
      authEvent({
        action: 'auth.session.revoked',
        outcome: 'success',
        traceId: ctx.traceId,
        user: { id: view.userId, idpSubject: view.idpSubject },
        sessionId: view.sessionId,
        details: { sid: view.sessionId, revoked_by: 'system', cause: 'reuse_detected' },
      }),
    ]);
    await record(view, 'reuse_detected');
    throw denied('reuse_detected');
  };

  // 1. Classify the presented token.
  const view = await withOrg(
    deps.db,
    orgId,
    (trx) => findRefreshToken(trx, request.refresh_token),
    {
      readOnly: true,
    },
  );
  if (view === undefined || view.clientId !== CLI_CLIENT_ID) {
    throw new OAuthProblem({ error: 'invalid_grant' });
  }
  if (view.tokenStatus === 'rotated') return reuse(view);
  if (view.tokenStatus === 'revoked' || view.sessionStatus !== 'active') {
    await record(view, 'revoked');
    throw denied('revoked');
  }
  if (view.tokenExpired || view.sessionExpired) {
    await record(view, 'expired');
    throw denied('expired');
  }
  if (audience !== 'control-plane' && !view.roles.includes('user')) {
    throw new OAuthProblem({
      error: 'invalid_scope',
      error_description: 'audience needs the user role',
    });
  }

  // A user already disabled here is refused without asking the IdP (an outage can't turn a
  // known-disabled user into temporarily_unavailable).
  if (view.userStatus === 'disabled') {
    await withOrg(deps.db, orgId, (trx) => revokeUser(trx, view.userId, 'user_disabled'));
    await record(view, 'user_disabled', { directory: 'local' }, 'user_disabled');
    throw denied('user_disabled');
  }

  // 2. Re-check the user at the IdP (never inside a transaction).
  const check = await deps.directory.check({
    idpSubject: view.idpSubject,
    tenantId: view.idpTenantId,
  });
  if (check.kind === 'unavailable') {
    await record(view, 'idp_unavailable');
    throw denied('idp_unavailable');
  }
  if (check.kind === 'disabled' || check.kind === 'deleted') {
    await withOrg(deps.db, orgId, (trx) =>
      revokeUser(trx, view.userId, 'user_disabled', { disable: true }),
    );
    await record(view, 'user_disabled', { directory: check.kind }, 'user_disabled');
    throw denied('user_disabled');
  }
  if (check.sessionsValidFrom !== null && check.sessionsValidFrom > view.sessionCreatedAt) {
    await withOrg(deps.db, orgId, (trx) => revokeUser(trx, view.userId, 'idp_sessions_revoked'));
    await record(view, 'idp_session_revoked', {}, 'idp_sessions_revoked');
    throw denied('idp_session_revoked');
  }
  const roles: SessionRole[] = view.roles.filter(
    (role) =>
      (role === 'user' && check.inAccessGroup) || (role === 'platform_admin' && check.inAdminGroup),
  );
  if (roles.length === 0) {
    await withOrg(deps.db, orgId, (trx) =>
      revokeSession(trx, view.sessionId, 'not_in_access_group'),
    );
    await record(view, 'not_in_access_group', {}, 'not_in_access_group');
    throw denied('not_in_access_group');
  }
  if (audience !== 'control-plane' && !roles.includes('user')) {
    throw new OAuthProblem({
      error: 'invalid_scope',
      error_description: 'audience needs the user role',
    });
  }

  // 3. Rotate (one-statement guard) and 4. issue.
  const issued = await withOrg(deps.db, orgId, async (trx) => {
    if (!(await markRotated(trx, view.tokenId))) return undefined;
    const next = await issueRefreshToken(trx, {
      orgId,
      sessionId: view.sessionId,
      parentId: view.tokenId,
      idleSeconds: deps.config.tokens.refresh_idle_s,
    });
    await trx
      .updateTable('cp.auth_session')
      .set({ last_refresh_at: sql<Date>`clock_timestamp()`, roles })
      .where('id', '=', view.sessionId)
      .execute();
    return next;
  });
  if (issued === undefined) return reuse(view);

  const now = Math.floor(Date.now() / 1000);
  const jti = uuidv7();
  const accessToken = await mintAccessToken(deps.keys, {
    iss: deps.config.public_base_url.replace(/\/+$/, ''),
    aud: audience,
    sub: view.userId,
    client_id: CLI_CLIENT_ID,
    tid: orgId,
    sid: view.sessionId,
    idp_sub: view.idpSubject,
    surface: view.surface as 'cli' | 'desktop' | 'web' | 'automation',
    auth_time: Math.floor(view.sessionCreatedAt.getTime() / 1000),
    region: deps.config.org.region,
    token_use: 'access',
    iat: now,
    nbf: now,
    exp: now + deps.config.tokens.access_ttl_s,
    jti,
  });
  // Non-blocking: a failed write is spooled, the token still goes out (§3.5).
  void deps.writer
    .writeOrSpool(orgId, [
      authEvent({
        action: 'auth.token.issued',
        outcome: 'success',
        traceId: ctx.traceId,
        user: { id: view.userId, idpSubject: view.idpSubject },
        sessionId: view.sessionId,
        details: { audience, grant_type: 'refresh_token', sid: view.sessionId, jti },
      }),
    ])
    .catch(() => undefined);
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: deps.config.tokens.access_ttl_s,
    refresh_token: issued.token,
  };
}
