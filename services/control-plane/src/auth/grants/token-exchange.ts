// The RFC 8693 token-exchange grant: flow A's second leg (F-002 design §3.2.5, §5.1; AC-2, AC-4;
// SEC-F002-05, -06, -07, -32).
//
//   1–3. entra-token-validator.ts: header, signature, pinned claims. A failure is recorded with
//        the HMAC of the unverified preferred_username (never the name) [AR-17].
//   4.   Consume first: the `uti` hash is inserted and committed on its own. A conflict is
//        `replay`. From here on every outcome has burned the IdP token [SEC-F002-07].
//   5.   Tenant switch: device code off → `unauthorized_client`, denied `device_code_disabled`.
//   6.   MFA evidence when `require_mfa_claim` (production default): `amr` contains `mfa` or
//        `acrs` is non-empty, else failure `mfa_claim_missing` [SEC-F002-06].
//   7.   sign-in.ts: Graph, the access decision, audience, provisioning; then the access token
//        is minted, `auth.sign_in success` written fail-closed, and the tokens returned.
// The IdP's `ipaddr` is compared with the exchange's client IP: a mismatch is recorded
// (`details.ip_mismatch`), counted (`auth_device_ip_mismatch_total`) and logged for the alert
// rule, but not denied until Q4 is answered (TC-F-002-28) [SEC-F002-05].
//
// A request that doesn't parse (wrong client, missing subject_token) is `invalid_request` and not
// a sign-in attempt: it never reached IdP-token handling. Anything unexpected after that is
// recorded as `auth.sign_in error internal_error` (AC-4: every attempt exactly once).
import { type Audience, ACCESS_TOKEN_TYPE_URN, TokenExchangeRequest } from '@ralysa/protocol/auth';
import { OAuthProblem } from '../../http/errors.js';
import { authEvent } from '../audit-events.js';
import { sanitizeDisplayText } from '../display-text.js';
import type { EntraTokenValidator } from '../idp/entra-token-validator.js';
import { mfaClaimRequired } from '../../config/schema.js';
import {
  type AttemptContext,
  SignInAttempt,
  type SignInEnv,
  USER_AGENT_MAX,
  authorizeAndProvision,
  identityDetails,
  mintForSession,
  recordSuccess,
  replayKey,
} from '../sign-in.js';
import type { GrantContext } from './refresh-token.js';

export interface ExchangeEnv extends SignInEnv {
  validator: EntraTokenValidator;
}

export interface ExchangeResult {
  access_token: string;
  issued_token_type: typeof ACCESS_TOKEN_TYPE_URN;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

export const DEVICE_LABEL_MAX = 64;

export async function tokenExchangeGrant(
  env: ExchangeEnv,
  body: unknown,
  ctx: GrantContext & { userAgent?: string },
): Promise<ExchangeResult> {
  const parsed = TokenExchangeRequest.safeParse(body);
  if (!parsed.success) throw new OAuthProblem({ error: 'invalid_request' });
  const request = parsed.data;
  const audience: Audience = request.audience ?? 'control-plane';
  const attemptCtx: AttemptContext = {
    flow: 'idp_device',
    traceId: ctx.traceId,
    clientIp: ctx.clientIp,
    userAgent: sanitizeDisplayText(ctx.userAgent, USER_AGENT_MAX),
    deviceLabel: sanitizeDisplayText(request.device_label, DEVICE_LABEL_MAX),
  };
  const attempt = new SignInAttempt(env, attemptCtx);
  try {
    return await exchange(env, attempt, request.subject_token, audience);
  } catch (error) {
    if (attempt.recorded) throw error;
    // An exit nobody recorded: an internal fault (database, signing). Record it once.
    env.logger.error('sign_in_internal_error', { flow: 'idp_device', error: String(error) });
    throw await attempt.refuse('internal_error');
  }
}

async function exchange(
  env: ExchangeEnv,
  attempt: SignInAttempt,
  subjectToken: string,
  audience: Audience,
): Promise<ExchangeResult> {
  const { config } = env;

  // 1–3. The IdP token.
  const validated = await env.validator.validateAccessToken(subjectToken);
  if (!validated.ok) {
    const hmac = await env.hmac.of(validated.unverifiedIdentifier);
    throw await attempt.refuse(validated.reason, {
      details: {
        check: validated.check,
        identifier_verified: false,
        ...(hmac === undefined ? {} : { attempted_identifier_hmac: hmac }),
      },
    });
  }
  const identity = validated.identity;
  const idpActor = { id: null, idpSubject: identity.oid };
  const details = identityDetails(identity, attempt.ctx.clientIp);

  // 4. Consume first: committed on its own, before anything else can fail.
  if (!(await env.store.consumeIdpToken(replayKey(identity.uti), identity.exp))) {
    throw await attempt.refuse('replay', { actor: idpActor, details });
  }

  // 5. Tenant switch (server-side; flow B never uses this grant).
  if (!config.access.device_code_enabled) {
    throw await attempt.refuse('device_code_disabled', { actor: idpActor, details });
  }

  // 6. MFA evidence.
  if (mfaClaimRequired(config) && !identity.amr.includes('mfa') && identity.acrs.length === 0) {
    throw await attempt.refuse('mfa_claim_missing', { actor: idpActor, details });
  }

  if (details.ip_mismatch === true) {
    env.metrics.increment('auth_device_ip_mismatch_total');
    env.logger.warn('auth_device_ip_mismatch', {
      flow: 'idp_device',
      trace_id: attempt.ctx.traceId,
    });
  }

  // 7. Graph, decision, audience, provisioning (a refusal throws, recorded).
  const authorized = await authorizeAndProvision(attempt, identity, {
    audience,
    sessionStatus: 'active',
    details,
  });
  const sid = authorized.provisioned.sessionId;
  const refreshToken = authorized.provisioned.refreshToken;
  if (refreshToken === undefined) throw new Error('flow A session without a refresh token');

  let minted;
  try {
    minted = await mintForSession(env, {
      userId: authorized.provisioned.userId,
      sessionId: sid,
      idpSubject: identity.oid,
      audience,
      amr: identity.amr,
      authTime: Math.floor((env.now ?? Date.now)() / 1000),
    });
  } catch (error) {
    // Signing failed (OpenBao, custody): the committed session must not stay usable.
    env.logger.error('sign_in_signing_failed', { error: String(error) });
    await env.store.revokeSession(sid, 'internal_error').catch(() => undefined);
    throw await attempt.refuse('internal_error', {
      actor: authorized.actor,
      sessionId: sid,
      details,
    });
  }

  const failed = await recordSuccess(
    attempt,
    {
      actor: authorized.actor,
      sessionId: sid,
      roles: authorized.roles,
      adminRoleWithheld: authorized.adminRoleWithheld,
      directoryEvents: authorized.directoryEvents,
    },
    details,
  );
  if (failed !== undefined) throw failed;

  // Non-blocking (§3.5): a failed write is spooled, the tokens still go out.
  void env.writer
    .writeOrSpool(config.org.id, [
      authEvent({
        action: 'auth.token.issued',
        outcome: 'success',
        traceId: attempt.ctx.traceId,
        user: { id: authorized.provisioned.userId, idpSubject: identity.oid },
        sessionId: sid,
        details: { audience, grant_type: 'token-exchange', sid, jti: minted.jti },
      }),
    ])
    .catch(() => undefined);

  return {
    access_token: minted.accessToken,
    issued_token_type: ACCESS_TOKEN_TYPE_URN,
    token_type: 'Bearer',
    expires_in: config.tokens.access_ttl_s,
    refresh_token: refreshToken,
  };
}
