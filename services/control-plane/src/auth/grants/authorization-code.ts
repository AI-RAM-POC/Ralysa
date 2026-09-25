// The authorization_code grant: flow B's last leg (F-002 design §3.3, §5.2; AC-1, AC-4;
// SEC-F002-04, -20; D-29, D-38).
//
//   1. The code is consumed only by a matching redemption: the client, the exact redirect URI and
//      S256(code_verifier) = the stored challenge, in one UPDATE (sessions.ts). A live code
//      presented with the wrong verifier is `invalid_grant` and stays redeemable by its owner; an
//      unknown or expired code is `invalid_grant`. None of these is a sign-in attempt (the
//      attempt belongs to the code's owner, and an unredeemed code is recorded by cleanup).
//   2. A used code (tombstone) is reuse: the session it created is revoked,
//      `auth.token.reuse_detected` (token_kind authorization_code) is written, `invalid_grant`.
//   3. The redemption IP is compared with the callback IP. In a genuine loopback flow the browser
//      and the CLI are the same host. With `access.loopback_ip_mismatch = deny` (default) the
//      pending session is revoked and `auth.sign_in denied loopback_ip_mismatch` is written; with
//      `alert` the sign-in proceeds with `details.ip_mismatch = true`, a metric and a log line.
//   4. The pending session is activated with its first refresh token, the access token minted,
//      and `auth.sign_in success` written FAIL-CLOSED (§5.8), once per attempt.
import { AuthorizationCodeRequest, CLI_CLIENT_ID } from '@ralysa/protocol/auth';
import { z } from 'zod';
import { OAuthProblem } from '../../http/errors.js';
import { sameIp } from '../../http/ip.js';
import { authEvent } from '../audit-events.js';
import { sanitizeDisplayText } from '../display-text.js';
import { codeReuseEvents, s256 } from '../flow-b.js';
import {
  SignInAttempt,
  type SignInEnv,
  USER_AGENT_MAX,
  mintForSession,
  recordSuccess,
} from '../sign-in.js';
import type { SessionRole } from '../sessions.js';
import type { GrantContext, TokenResult } from './refresh-token.js';

/** What the callback stored with the code (cp/0006). Our own data, still parsed. */
const StoredSignIn = z.looseObject({
  amr: z.array(z.string().max(32)).max(16).default([]),
  acr: z.array(z.string().max(32)).max(16).default([]),
  idp_ipaddr: z.string().max(64).optional(),
  roles: z.array(z.enum(['user', 'platform_admin'])).default([]),
  admin_role_withheld: z.boolean().default(false),
  auth_time: z.int().optional(),
  browser_user_agent: z.string().max(USER_AGENT_MAX).optional(),
  authorize_ip: z.string().max(64).optional(),
});

export async function authorizationCodeGrant(
  env: SignInEnv,
  body: unknown,
  ctx: GrantContext & { userAgent?: string },
): Promise<TokenResult> {
  const parsed = AuthorizationCodeRequest.safeParse(body);
  if (!parsed.success) throw new OAuthProblem({ error: 'invalid_request' });
  const request = parsed.data;
  const orgId = env.config.org.id;

  // 1–2. Consume the code, bound to the client, the redirect URI and the PKCE verifier.
  const redemption = await env.store.redeemCode(request.code, {
    clientId: CLI_CLIENT_ID,
    redirectUri: request.redirect_uri,
    codeChallenge: s256(request.code_verifier),
  });
  if (redemption.kind === 'invalid' || redemption.kind === 'mismatch') {
    throw new OAuthProblem({ error: 'invalid_grant' });
  }
  if (redemption.kind === 'reused') {
    const owner = await env.store.sessionOwner(redemption.sessionId).catch(() => undefined);
    await env.writer
      .writeOrSpool(
        orgId,
        codeReuseEvents({
          traceId: ctx.traceId,
          sessionId: redemption.sessionId,
          owner,
          revoked: redemption.revoked,
        }),
      )
      .catch(() => undefined);
    throw new OAuthProblem({ error: 'invalid_grant' });
  }

  const sid = redemption.sessionId;
  const stored = StoredSignIn.safeParse(redemption.signIn);
  const attempt = new SignInAttempt(env, {
    flow: 'loopback_pkce',
    traceId: ctx.traceId,
    clientIp: ctx.clientIp,
    userAgent: sanitizeDisplayText(ctx.userAgent, USER_AGENT_MAX),
    deviceLabel: undefined,
    ...(stored.success && stored.data.authorize_ip !== undefined
      ? { authorizeIp: stored.data.authorize_ip }
      : {}),
  });
  if (!stored.success) {
    // Our own row, but not what the callback writes: never guess the roles or amr (review of #30).
    env.logger.error('auth_code_sign_in_invalid', { trace_id: ctx.traceId });
    env.metrics.increment('auth_code_sign_in_invalid_total');
    await env.store.revokeSession(sid, 'internal_error').catch(() => false);
    throw await attempt.refuse('internal_error', {
      sessionId: sid,
      details: {
        cause: 'stored_sign_in_invalid',
        ...(redemption.callbackIp === null ? {} : { callback_ip: redemption.callbackIp }),
      },
    });
  }
  const signIn = stored.data;
  try {
    const owner = await env.store.sessionOwner(sid);
    if (owner === undefined) throw new Error('code without a session owner');
    const actor = { id: owner.userId, idpSubject: owner.idpSubject };
    const ipMismatch =
      redemption.callbackIp !== null && !sameIp(redemption.callbackIp, ctx.clientIp);
    const details: Record<string, unknown> = {
      amr: signIn.amr,
      acr: signIn.acr,
      ...(signIn.idp_ipaddr === undefined ? {} : { idp_ipaddr: signIn.idp_ipaddr }),
      ...(signIn.browser_user_agent === undefined
        ? {}
        : { browser_user_agent: signIn.browser_user_agent }),
      ...(redemption.callbackIp === null ? {} : { callback_ip: redemption.callbackIp }),
      ip_mismatch: ipMismatch,
    };

    // 3. The redeeming host must be the one the browser came back to [SEC-F002-04 a, D-29].
    if (ipMismatch) {
      env.metrics.increment('auth_loopback_ip_mismatch_total');
      env.logger.warn('auth_loopback_ip_mismatch', {
        mode: env.config.access.loopback_ip_mismatch,
        trace_id: ctx.traceId,
      });
      if (env.config.access.loopback_ip_mismatch === 'deny') {
        const revoked = await env.store.revokeSession(sid, 'loopback_ip_mismatch');
        throw await attempt.refuse('loopback_ip_mismatch', {
          actor,
          sessionId: sid,
          details,
          before: revoked
            ? [
                authEvent({
                  action: 'auth.session.revoked',
                  outcome: 'success',
                  traceId: ctx.traceId,
                  user: actor,
                  sessionId: sid,
                  details: { sid, revoked_by: 'system', cause: 'loopback_ip_mismatch' },
                }),
              ]
            : [],
        });
      }
    }

    // 4. Activate, mint, record (fail closed).
    const refreshToken = await env.store.activateSession(sid, env.config.tokens.refresh_idle_s);
    if (refreshToken === undefined) {
      // Revoked or expired between the callback and now (user disabled, device switch, cleanup).
      throw await attempt.refuse('expired', {
        actor,
        sessionId: sid,
        details: { ...details, cause: 'session_not_pending' },
      });
    }
    let minted;
    try {
      minted = await mintForSession(env, {
        userId: owner.userId,
        sessionId: sid,
        idpSubject: owner.idpSubject,
        audience: 'control-plane',
        amr: signIn.amr,
        authTime: signIn.auth_time ?? Math.floor((env.now ?? Date.now)() / 1000),
      });
    } catch (error) {
      env.logger.error('sign_in_signing_failed', { error: String(error) });
      await env.store.revokeSession(sid, 'internal_error').catch(() => false);
      throw await attempt.refuse('internal_error', { actor, sessionId: sid, details });
    }
    const roles: SessionRole[] = owner.roles;
    const failed = await recordSuccess(
      attempt,
      {
        actor,
        sessionId: sid,
        roles,
        adminRoleWithheld: signIn.admin_role_withheld,
        directoryEvents: [],
      },
      details,
    );
    if (failed !== undefined) throw failed;

    void env.writer
      .writeOrSpool(orgId, [
        authEvent({
          action: 'auth.token.issued',
          outcome: 'success',
          traceId: ctx.traceId,
          user: actor,
          sessionId: sid,
          details: {
            audience: 'control-plane',
            grant_type: 'authorization_code',
            sid,
            jti: minted.jti,
          },
        }),
      ])
      .catch(() => undefined);
    return {
      access_token: minted.accessToken,
      token_type: 'Bearer',
      expires_in: env.config.tokens.access_ttl_s,
      refresh_token: refreshToken,
    };
  } catch (error) {
    if (attempt.recorded) throw error;
    env.logger.error('sign_in_internal_error', { flow: 'loopback_pkce', error: String(error) });
    await env.store.revokeSession(sid, 'internal_error').catch(() => false);
    throw await attempt.refuse('internal_error');
  }
}
