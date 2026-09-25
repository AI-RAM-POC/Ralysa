// Flow B, `/login --browser`: loopback + PKCE through RTS (F-002 design §5.2, §3.3; AC-1, AC-4;
// SEC-F002-04, -20; D-29, D-38). RTS is the authorization server toward the CLI and an OIDC
// relying party toward the IdP.
//
// startAuthorize (GET /oauth2/authorize):
//   - An unknown `client_id` or a `redirect_uri` that isn't IP-literal loopback is never redirected
//     (RFC 6749 §4.1.2.1): the route answers a plain-text en/ar error. Any other bad parameter is
//     redirected back to the loopback as `invalid_request`.
//   - A fresh state, nonce and PKCE verifier toward the IdP, and a browser-binding value whose
//     hash is stored with the request and whose value goes into the `__Host-rts_tx` cookie. The
//     request is kept 10 minutes with the authorize IP.
//
// completeCallback (GET /oauth2/idp/callback):
//   - The request is consumed atomically (DELETE … RETURNING). Unknown → plain-text error;
//     expired → `invalid_request` to the loopback. Neither is a sign-in attempt.
//   - From here the attempt is recorded exactly once: the cookie must match
//     (`browser_binding_failed`, and no redirect: this browser didn't start the flow); an IdP
//     `error` is `idp_error`; the IdP code is redeemed (openid-client: state, nonce, PKCE, ID
//     token) and the ID token checked against the pinned rules; MFA evidence; then Graph, the
//     decision and provisioning with a PENDING session (sign-in.ts).
//   - An allowed callback creates a 60 s `rly_ac_` code bound to the client, the exact redirect
//     URI, the CLI's PKCE challenge and the callback IP, and redirects with it. No success event
//     yet: `auth.sign_in success` is written at code redemption (authorization-code grant), or
//     `failure code_not_redeemed` by the cleanup job (D-38).
//   - A refusal redirects to the loopback with `error=access_denied` (or
//     `temporarily_unavailable` for a dependency fault) and `error_description=<SignInReason>`.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthorizeQuery, CLI_CLIENT_ID } from '@ralysa/protocol/auth';
import { mfaClaimRequired } from '../config/schema.js';
import { OAuthProblem } from '../http/errors.js';
import { authEvent } from './audit-events.js';
import { sanitizeDisplayText } from './display-text.js';
import type { EntraTokenValidator } from './idp/entra-token-validator.js';
import type { OidcClient } from './idp/oidc-client.js';
import { idpCallbackUrl } from './idp/oidc-client.js';
import { SignInAttempt, type SignInEnv, USER_AGENT_MAX, authorizeAndProvision } from './sign-in.js';
import type { AuthRequest } from './sign-in-store.js';
import { newAuthorizationCode } from './tokens/opaque.js';

export const AUTH_REQUEST_TTL_S = 600;
export const AUTHORIZATION_CODE_TTL_S = 60;
export const BINDING_COOKIE = '__Host-rts_tx';
/** Only outside production on plain-http loopback (the dev stack and tests). */
export const BINDING_COOKIE_DEV = 'rts_tx';

export interface FlowBEnv extends SignInEnv {
  validator: EntraTokenValidator;
  oidc: OidcClient;
}

/** The browser-binding cookie to set (authorize) or clear (callback, when the request was found). */
export interface CookieChange {
  setCookie?: { name: string; value: string };
  clearCookie?: string;
}

export type AuthorizeOutcome =
  | ({ kind: 'redirect'; location: string } & CookieChange)
  /** Not redirectable (bad client or redirect URI, unknown state): the plain-text en/ar error. */
  | ({ kind: 'invalid' } & CookieChange);

const random = (): string => randomBytes(32).toString('base64url');
const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
export const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');

/**
 * The binding cookie's name and attributes (SEC-F002-04 b). The name carries a short id derived
 * from RTS's state toward the IdP, so two flows in one browser each keep their own cookie, and
 * the callback (which gets that state back) knows which one to read and clear (review of #30).
 */
export function bindingCookie(
  config: SignInEnv['config'],
  rtsState: string,
): { name: string; secure: boolean } {
  const id = createHash('sha256').update(rtsState, 'utf8').digest('base64url').slice(0, 12);
  const insecureDev = config.env !== 'production' && config.public_base_url.startsWith('http://');
  return insecureDev
    ? { name: `${BINDING_COOKIE_DEV}_${id}`, secure: false }
    : { name: `${BINDING_COOKIE}_${id}`, secure: true };
}

function withParams(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.href;
}

export async function startAuthorize(
  env: FlowBEnv,
  query: Record<string, unknown>,
  ctx: { clientIp: string },
): Promise<AuthorizeOutcome> {
  const redirect = AuthorizeQuery.shape.redirect_uri.safeParse(query.redirect_uri);
  if (query.client_id !== CLI_CLIENT_ID || !redirect.success) return { kind: 'invalid' };
  const clientState =
    typeof query.state === 'string' && query.state.length <= 128 ? query.state : undefined;
  const parsed = AuthorizeQuery.safeParse(query);
  if (!parsed.success) {
    return {
      kind: 'redirect',
      location: withParams(redirect.data, { error: 'invalid_request', state: clientState }),
    };
  }
  const state = random();
  const nonce = random();
  const verifier = random();
  const binding = random();
  let location: string;
  try {
    location = await env.oidc.authorizationUrl({ state, nonce, codeChallenge: s256(verifier) });
  } catch (error) {
    env.logger.warn('idp_discovery_failed', { error: String(error) });
    return {
      kind: 'redirect',
      location: withParams(redirect.data, {
        error: 'temporarily_unavailable',
        error_description: 'idp_unavailable',
        state: clientState,
      }),
    };
  }
  await env.store.saveAuthRequest(
    {
      stateHash: sha256(state),
      browserBindingHash: sha256(binding),
      clientRedirectUri: parsed.data.redirect_uri,
      clientState: parsed.data.state,
      clientCodeChallenge: parsed.data.code_challenge,
      authorizeIp: ctx.clientIp,
      idpCodeVerifier: verifier,
      idpNonce: nonce,
    },
    AUTH_REQUEST_TTL_S,
  );
  return {
    kind: 'redirect',
    location,
    setCookie: { name: bindingCookie(env.config, state).name, value: binding },
  };
}

const bindingMatches = (presented: string | undefined, storedHash: Buffer): boolean =>
  presented !== undefined &&
  presented.length <= 128 &&
  timingSafeEqual(sha256(presented), storedHash);

export async function completeCallback(
  env: FlowBEnv,
  query: Record<string, unknown>,
  ctx: {
    clientIp: string;
    traceId: string;
    userAgent: string | undefined;
    /** Reads a cookie the browser sent. */
    cookie: (name: string) => string | undefined;
    /** The raw query string, `?…` included, for openid-client's response checks. */
    rawQuery: string;
  },
): Promise<AuthorizeOutcome> {
  const state = typeof query.state === 'string' && query.state.length <= 512 ? query.state : '';
  if (state === '') return { kind: 'invalid' };
  const request = await env.store.consumeAuthRequest(sha256(state));
  // An unknown state clears nothing: the cookie of another flow in this browser must survive.
  if (request === undefined) return { kind: 'invalid' };
  const cookieName = bindingCookie(env.config, state).name;
  const outcome = await continueCallback(env, query, ctx, state, request, ctx.cookie(cookieName));
  return { ...outcome, clearCookie: cookieName };
}

async function continueCallback(
  env: FlowBEnv,
  query: Record<string, unknown>,
  ctx: { clientIp: string; traceId: string; userAgent: string | undefined; rawQuery: string },
  state: string,
  request: AuthRequest & { live: boolean },
  binding: string | undefined,
): Promise<AuthorizeOutcome> {
  const back = (params: Record<string, string | undefined>): AuthorizeOutcome => ({
    kind: 'redirect',
    location: withParams(request.clientRedirectUri, { ...params, state: request.clientState }),
  });
  if (!request.live) return back({ error: 'invalid_request' });

  const refused = (problem: OAuthProblem): AuthorizeOutcome =>
    back({
      error: problem.status === 503 ? 'temporarily_unavailable' : 'access_denied',
      error_description: problem.body.ralysa_error?.code ?? problem.body.error,
    });
  const attempt = new SignInAttempt(env, {
    flow: 'loopback_pkce',
    traceId: ctx.traceId,
    clientIp: ctx.clientIp,
    userAgent: sanitizeDisplayText(ctx.userAgent, USER_AGENT_MAX),
    deviceLabel: undefined,
    authorizeIp: request.authorizeIp,
  });
  let pendingSession: string | undefined;
  try {
    if (!bindingMatches(binding, request.browserBindingHash)) {
      await attempt.refuse('browser_binding_failed', {
        details: { check: binding === undefined ? 'cookie_missing' : 'cookie_mismatch' },
      });
      return { kind: 'invalid' };
    }
    if (typeof query.error === 'string') {
      return refused(
        await attempt.refuse('idp_error', {
          details: { idp_error: sanitizeDisplayText(query.error, 64) ?? 'unknown' },
        }),
      );
    }

    const redeemed = await env.oidc.redeem(
      new URL(`${idpCallbackUrl(env.config)}${ctx.rawQuery}`),
      { state, nonce: request.idpNonce, codeVerifier: request.idpCodeVerifier },
    );
    if (redeemed.kind === 'unavailable') {
      return refused(
        await attempt.refuse('idp_unavailable', { details: { check: redeemed.reason } }),
      );
    }
    if (redeemed.kind === 'rejected') {
      return refused(
        await attempt.refuse('invalid_idp_token', { details: { check: redeemed.reason } }),
      );
    }
    const validated = await env.validator.validateIdToken(redeemed.idToken);
    if (!validated.ok) {
      const hmac = await env.hmac.of(validated.unverifiedIdentifier);
      return refused(
        await attempt.refuse(validated.reason, {
          details: {
            check: validated.check,
            identifier_verified: false,
            ...(hmac === undefined ? {} : { attempted_identifier_hmac: hmac }),
          },
        }),
      );
    }
    const identity = validated.identity;
    const actor = { id: null, idpSubject: identity.oid };
    const details: Record<string, unknown> = {
      amr: identity.amr,
      acr: identity.acrs,
      ...(identity.ipaddr === undefined ? {} : { idp_ipaddr: identity.ipaddr }),
    };
    if (
      mfaClaimRequired(env.config) &&
      !identity.amr.includes('mfa') &&
      identity.acrs.length === 0
    ) {
      return refused(await attempt.refuse('mfa_claim_missing', { actor, details }));
    }

    const authorized = await authorizeAndProvision(attempt, identity, {
      audience: 'control-plane',
      sessionStatus: 'pending',
      details,
    });
    pendingSession = authorized.provisioned.sessionId;
    if (authorized.directoryEvents.length > 0) {
      void env.writer
        .writeOrSpool(env.config.org.id, authorized.directoryEvents)
        .catch(() => undefined);
    }
    const code = newAuthorizationCode();
    await env.store.createCode({
      code,
      sessionId: pendingSession,
      clientId: CLI_CLIENT_ID,
      redirectUri: request.clientRedirectUri,
      codeChallenge: request.clientCodeChallenge,
      callbackIp: ctx.clientIp,
      ttlSeconds: AUTHORIZATION_CODE_TTL_S,
      signIn: {
        ...details,
        roles: authorized.roles,
        admin_role_withheld: authorized.adminRoleWithheld,
        auth_time: Math.floor((env.now ?? Date.now)() / 1000),
        ...(request.authorizeIp === null ? {} : { authorize_ip: request.authorizeIp }),
        ...(attempt.ctx.userAgent === undefined
          ? {}
          : { browser_user_agent: attempt.ctx.userAgent }),
      },
    });
    // Recorded at redemption (success or a refusal) or by cleanup (code_not_redeemed).
    return back({ code });
  } catch (error) {
    if (error instanceof OAuthProblem && attempt.recorded) return refused(error);
    if (attempt.recorded) throw error;
    env.logger.error('sign_in_internal_error', { flow: 'loopback_pkce', error: String(error) });
    if (pendingSession !== undefined) {
      await env.store.revokeSession(pendingSession, 'internal_error').catch(() => false);
    }
    return refused(await attempt.refuse('internal_error'));
  }
}

/** auth.token.reuse_detected for a second redemption of a code (SEC-F002-20). */
export function codeReuseEvents(input: {
  traceId: string;
  sessionId: string;
  owner: { userId: string; idpSubject: string } | undefined;
  revoked: boolean;
}) {
  const user =
    input.owner === undefined
      ? undefined
      : { id: input.owner.userId, idpSubject: input.owner.idpSubject };
  return [
    authEvent({
      action: 'auth.token.reuse_detected',
      outcome: 'denied',
      traceId: input.traceId,
      ...(user === undefined ? {} : { user }),
      sessionId: input.sessionId,
      details: {
        sid: input.sessionId,
        revoked_count: input.revoked ? 1 : 0,
        token_kind: 'authorization_code',
      },
    }),
    ...(input.revoked
      ? [
          authEvent({
            action: 'auth.session.revoked',
            outcome: 'success',
            traceId: input.traceId,
            ...(user === undefined ? {} : { user }),
            sessionId: input.sessionId,
            details: { sid: input.sessionId, revoked_by: 'system', cause: 'reuse_detected' },
          }),
        ]
      : []),
  ];
}
