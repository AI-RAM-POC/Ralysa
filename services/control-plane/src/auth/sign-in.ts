// Completing a sign-in (F-002 design §5.1, §5.8, §6.1, §6.3, §6.4; AC-1, AC-4, AC-5, AC-6).
//
// Every attempt that reaches here ends with EXACTLY ONE `auth.sign_in` event (AC-4). SignInAttempt
// enforces it: a second record throws, and the grant handlers record `internal_error` for any
// exit that wasn't recorded (the exits are enumerated in test/sign-in-exits.test.ts).
//   - Refusals (failure/denied/error) go through AuditWriter.writeOrSpool: a refusal stands even
//     when its audit write fails (ADR-0022 rule 5).
//   - Success is FAIL-CLOSED: the session is committed first, then `auth.sign_in success` is
//     written synchronously. If that write fails, the session is revoked (`audit_unavailable`),
//     the same event and the revocation are spooled, and the client gets
//     temporarily_unavailable. No tokens leave RTS without a committed `auth.sign_in` (§5.8).
//
// Decision order after the IdP token is validated (flow A, §3.2.5 step 7; flow B, §5.2):
//   1. Graph (§6.3): unreachable → error `idp_unavailable`, or `group_overage_unresolved` when the
//      token signalled overage; disabled or deleted (404) → denied `user_disabled`, and a known
//      user is disabled and everything they hold revoked; Entra sessions revoked after the IdP
//      token was issued → failure `expired` (details.cause idp_sessions_revoked).
//   2. identity-mapping.ts: roles from the two configured groups (Graph), admin only on strong
//      sign-ins → denied `not_in_access_group` / `admin_requires_strong_flow`.
//   3. The requested audience needs the `user` role unless it is `control-plane` (§6.1).
//   4. Group display names for display (Graph, 2 s, at most 20 per sign-in), then provision()
//      (user, groups, memberships, session) in one transaction, and the directory events.
import { createHash } from 'node:crypto';
import {
  type Audience,
  CLI_CLIENT_ID,
  SIGN_IN_REASON_OUTCOMES,
  type SignInReason,
  type UserAccessTokenClaims,
  signInI18nKey,
} from '@ralysa/protocol/auth';
import { uuidv7 } from '@ralysa/protocol/common';
import type { StoredEventInput } from '../audit/columns.js';
import type { AuditWriter } from '../audit/writer.js';
import type { ServeConfig } from '../config/schema.js';
import { OAuthProblem } from '../http/errors.js';
import { sameIp } from '../http/ip.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import { authEvent } from './audit-events.js';
import type { IdpDirectory } from './directory-port.js';
import type { IdpIdentity } from './idp/entra-token-validator.js';
import { type SignInFlow, audienceAllowed, decideSignIn } from './identity-mapping.js';
import type { IdentifierHmac } from './identifier-hmac.js';
import type { ProvisionResult, SignInStore } from './sign-in-store.js';
import type { SessionRole } from './sessions.js';

export const USER_AGENT_MAX = 256;

export interface SignInEnv {
  config: ServeConfig;
  policyVersion: string;
  directory: IdpDirectory;
  store: SignInStore;
  writer: AuditWriter;
  hmac: IdentifierHmac;
  mint: (claims: UserAccessTokenClaims) => Promise<string>;
  metrics: Metrics;
  logger: Logger;
  now?: () => number;
}

export interface AttemptContext {
  flow: SignInFlow;
  traceId: string;
  clientIp: string;
  /** Sanitised (display-text.ts). */
  userAgent: string | undefined;
  /** Sanitised (display-text.ts). */
  deviceLabel: string | undefined;
  /** Flow B: the IP that called /oauth2/authorize (review of #30, R30-2). */
  authorizeIp?: string | null;
}

export type Actor = { id: string | null; idpSubject: string | null };

/** The OAuth error a sign-in reason is answered with (§3.3, §3.9). */
export function signInProblem(reason: SignInReason, description?: string): OAuthProblem {
  const outcome = SIGN_IN_REASON_OUTCOMES[reason];
  const error =
    outcome === 'error'
      ? 'temporarily_unavailable'
      : reason === 'device_code_disabled'
        ? 'unauthorized_client'
        : outcome === 'denied'
          ? 'access_denied'
          : 'invalid_grant';
  return new OAuthProblem(
    {
      error,
      ...(description === undefined ? {} : { error_description: description }),
      ralysa_error: { code: reason, i18n_key: signInI18nKey(reason) },
    },
    outcome === 'error' ? 503 : 400,
  );
}

export class SignInRecordedTwiceError extends Error {
  constructor() {
    super('auth.sign_in recorded twice for one attempt');
    this.name = 'SignInRecordedTwiceError';
  }
}

/** One sign-in attempt: builds its events and guarantees exactly one `auth.sign_in`. */
export class SignInAttempt {
  #recorded = false;
  readonly env: SignInEnv;
  readonly ctx: AttemptContext;

  constructor(env: SignInEnv, ctx: AttemptContext) {
    this.env = env;
    this.ctx = ctx;
  }

  get recorded(): boolean {
    return this.#recorded;
  }

  #claim(): void {
    if (this.#recorded) throw new SignInRecordedTwiceError();
    this.#recorded = true;
  }

  /** The request facts every `auth.sign_in` carries (§3.5). */
  baseDetails(): Record<string, unknown> {
    return {
      flow: this.ctx.flow,
      protocol: 'oidc',
      client_type: 'public',
      client_ip: this.ctx.clientIp,
      reported_by: 'server',
      ...(this.ctx.userAgent === undefined ? {} : { user_agent: this.ctx.userAgent }),
      ...(this.ctx.deviceLabel === undefined ? {} : { device_label: this.ctx.deviceLabel }),
      ...(this.ctx.authorizeIp === undefined || this.ctx.authorizeIp === null
        ? {}
        : { authorize_ip: this.ctx.authorizeIp }),
    };
  }

  signInEvent(
    outcome: 'success' | 'failure' | 'denied' | 'error',
    reason: SignInReason | undefined,
    fields: { actor?: Actor; sessionId?: string; details?: Record<string, unknown> } = {},
  ): StoredEventInput {
    return authEvent({
      action: 'auth.sign_in',
      outcome,
      ...(reason === undefined ? {} : { reasonCode: reason }),
      traceId: this.ctx.traceId,
      ...(fields.actor === undefined
        ? {}
        : { user: { id: fields.actor.id, idpSubject: fields.actor.idpSubject } }),
      ...(fields.sessionId === undefined ? {} : { sessionId: fields.sessionId }),
      surface: 'cli',
      policyVersion: this.env.policyVersion,
      details: { ...this.baseDetails(), ...fields.details },
    });
  }

  /**
   * Records a refusal (with any events it caused, written first) and returns the OAuth error to
   * throw. The refusal stands even if the audit write fails.
   */
  async refuse(
    reason: SignInReason,
    fields: {
      actor?: Actor;
      sessionId?: string;
      details?: Record<string, unknown>;
      before?: StoredEventInput[];
    } = {},
  ): Promise<OAuthProblem> {
    this.#claim();
    const outcome = SIGN_IN_REASON_OUTCOMES[reason];
    const event = this.signInEvent(outcome, reason, fields);
    try {
      await this.env.writer.writeOrSpool(this.env.config.org.id, [...(fields.before ?? []), event]);
    } catch (error) {
      this.env.logger.error('sign_in_audit_lost', { reason, error: String(error) });
    }
    return signInProblem(reason);
  }

  /** Marks the attempt recorded by the caller's own (fail-closed) success write. */
  claimSuccess(): void {
    this.#claim();
  }
}

/** `amr`/`acrs`, the IdP's `ipaddr` and whether it differs from the client's (SEC-F002-05). */
export function identityDetails(identity: IdpIdentity, clientIp: string): Record<string, unknown> {
  return {
    amr: identity.amr,
    acr: identity.acrs,
    ...(identity.ipaddr === undefined
      ? {}
      : { idp_ipaddr: identity.ipaddr, ip_mismatch: !sameIp(identity.ipaddr, clientIp) }),
  };
}

export interface AuthorizedSignIn {
  actor: Actor;
  roles: SessionRole[];
  adminRoleWithheld: boolean;
  provisioned: ProvisionResult;
  /** directory.* events caused by provisioning (written with the success event). */
  directoryEvents: StoredEventInput[];
}

/**
 * Steps 1–4 above. Throws the OAuth error of a recorded refusal; on return the session exists
 * (active with a refresh token for flow A, pending for flow B) and nothing has been recorded yet.
 */
export async function authorizeAndProvision(
  attempt: SignInAttempt,
  identity: IdpIdentity,
  options: {
    audience: Audience;
    sessionStatus: 'active' | 'pending';
    details: Record<string, unknown>;
  },
): Promise<AuthorizedSignIn> {
  const { env } = attempt;
  const { config } = env;
  const known = await env.store.findUser(identity.issuer, identity.oid);
  const actor: Actor = { id: known?.id ?? null, idpSubject: identity.oid };
  const details = options.details;

  // 1. Graph: account state, Entra session revocation, configured-group membership. The
  //    database clock just before the call orders this answer against a concurrent refresh's
  //    (R58-r2-1, SEC-F002-53).
  const graphCheckedAt = await env.store.graphCheckTime();
  const check = await env.directory.check({
    idpSubject: identity.oid,
    tenantId: identity.tenantId,
  });
  if (check.kind === 'unavailable') {
    throw await attempt.refuse(
      identity.groups.kind === 'overage' ? 'group_overage_unresolved' : 'idp_unavailable',
      { actor, details: { ...details, directory: check.reason } },
    );
  }
  if (check.kind === 'disabled' || check.kind === 'deleted') {
    const before: StoredEventInput[] = [];
    if (known !== undefined) {
      const revoked = await env.store.revokeUser(known.id, 'user_disabled', true);
      if (revoked > 0) {
        before.push(
          authEvent({
            action: 'auth.session.revoked',
            outcome: 'success',
            traceId: attempt.ctx.traceId,
            user: { id: known.id, idpSubject: identity.oid },
            details: { user_id: known.id, revoked_by: 'system', cause: 'user_disabled' },
          }),
        );
      }
    }
    throw await attempt.refuse('user_disabled', {
      actor,
      before,
      details: { ...details, directory: check.kind },
    });
  }
  // Compared at `iat`'s whole-second precision: a token issued in the second of the revocation is
  // not treated as older than it.
  if (
    check.sessionsValidFrom !== null &&
    Math.floor(check.sessionsValidFrom.getTime() / 1000) > identity.iat
  ) {
    // The incident responder's "revoke sessions" also ends what this user already holds here, as
    // the next refresh would (review of #29, T10-2).
    const before: StoredEventInput[] = [];
    if (
      known !== undefined &&
      (await env.store.revokeUser(known.id, 'idp_sessions_revoked', false)) > 0
    ) {
      before.push(
        authEvent({
          action: 'auth.session.revoked',
          outcome: 'success',
          traceId: attempt.ctx.traceId,
          user: { id: known.id, idpSubject: identity.oid },
          details: { user_id: known.id, revoked_by: 'system', cause: 'idp_sessions_revoked' },
        }),
      );
    }
    throw await attempt.refuse('expired', {
      actor,
      before,
      details: { ...details, cause: 'idp_sessions_revoked' },
    });
  }

  // 2. The access decision (ADR-0011 shapes; Graph membership only).
  const decision = decideSignIn(config.access, env.policyVersion, {
    principal: {
      idpSubject: identity.oid,
      groups: { access: check.inAccessGroup, admin: check.inAdminGroup },
    },
    action: 'auth.sign_in',
    resource: { type: 'organization', id: config.org.id },
    context: { flow: attempt.ctx.flow, amr: identity.amr, acrs: identity.acrs },
  });
  if (decision.decision === 'deny') {
    const reason =
      decision.reasons[0] === 'admin_requires_strong_flow'
        ? 'admin_requires_strong_flow'
        : 'not_in_access_group';
    throw await attempt.refuse(reason, { actor, details });
  }
  const adminRoleWithheld = decision.reasons.includes('admin_role_withheld');
  // 3. Audience (§6.1).
  if (!audienceAllowed(decision.roles, options.audience)) {
    throw await attempt.refuse('not_in_access_group', {
      actor,
      details: { ...details, audience: options.audience, roles: decision.roles },
    });
  }

  // 4. Memberships: the configured groups as Graph reported them, plus the token's GUID groups
  //    (recorded for AC-1; never used for access). Non-GUID values are ignored and counted.
  const { access_group_id: accessId, admin_group_id: adminId } = config.access;
  const membership = new Map<string, 'token_claim' | 'graph_check'>();
  if (identity.groups.kind === 'list') {
    if (identity.groups.ignored > 0) {
      env.metrics.increment('idp_group_claims_ignored_total', {}, identity.groups.ignored);
    }
    for (const id of identity.groups.guids) {
      if (id !== accessId && id !== adminId) membership.set(id, 'token_claim');
    }
  }
  if (check.inAccessGroup) membership.set(accessId, 'graph_check');
  if (check.inAdminGroup) membership.set(adminId, 'graph_check');

  const groupNames = new Map<string, string | null>();
  if (env.directory.groupDisplayName !== undefined) {
    const lookup = env.directory.groupDisplayName.bind(env.directory);
    const needed = await env.store.groupsNeedingNames([...membership.keys()]);
    const names = await Promise.all(needed.map(async (id) => [id, await lookup(id)] as const));
    for (const [id, name] of names) if (name !== undefined) groupNames.set(id, name);
  }

  const provisioned = await env.store.provision({
    issuer: identity.issuer,
    tenantId: identity.tenantId,
    oid: identity.oid,
    email: identity.email ?? null,
    displayName: identity.name ?? null,
    groupNames,
    membership: [...membership].map(([idpGroupId, source]) => ({ idpGroupId, source })),
    claimsKnown: identity.groups.kind === 'list',
    graphCheckedAt,
    configured: { access: accessId, admin: adminId },
    session: {
      flow: attempt.ctx.flow,
      status: options.sessionStatus,
      roles: decision.roles,
      clientId: CLI_CLIENT_ID,
      surface: 'cli',
      deviceLabel: attempt.ctx.deviceLabel ?? null,
      createdIp: attempt.ctx.clientIp,
    },
    absoluteSeconds: config.tokens.refresh_absolute_s,
    idleSeconds: config.tokens.refresh_idle_s,
    issueRefreshToken: options.sessionStatus === 'active',
  });

  const user = { id: provisioned.userId, idpSubject: identity.oid };
  // Stored group roles differ from this replica's config (a rolling config change, or a replica
  // not yet restarted): sign-in changes no role; the next `serve` start reconciles and audits it.
  // Group object ids and role names only (R58-3, SEC-F002-52).
  if (provisioned.roleSkew.length > 0) {
    env.logger.warn('group_role_config_skew', {
      groups: provisioned.roleSkew.map((g) => ({
        idp_group_id: g.idpGroupId,
        stored: g.from,
        configured: g.to,
      })),
    });
  }
  const directoryEvents: StoredEventInput[] = [];
  if (provisioned.created || provisioned.changedAttributes.length > 0) {
    directoryEvents.push(
      authEvent({
        action: provisioned.created ? 'directory.user.provisioned' : 'directory.user.updated',
        outcome: 'success',
        traceId: attempt.ctx.traceId,
        user,
        details: { source: 'sign_in', changed_attributes: provisioned.changedAttributes },
      }),
    );
  }
  if (provisioned.added.length > 0 || provisioned.removed.length > 0) {
    directoryEvents.push(
      authEvent({
        action: 'directory.group_membership.changed',
        outcome: 'success',
        traceId: attempt.ctx.traceId,
        user,
        details: {
          added: provisioned.added,
          removed: provisioned.removed,
          // TM-49: a change to the admin group's membership is privileged.
          privileged: [...provisioned.added, ...provisioned.removed].includes(adminId),
        },
      }),
    );
  }
  return {
    actor: { id: provisioned.userId, idpSubject: identity.oid },
    roles: decision.roles,
    adminRoleWithheld,
    provisioned,
    directoryEvents,
  };
}

/** Mints a user access token for a session (§3.2.2). */
export async function mintForSession(
  env: SignInEnv,
  input: {
    userId: string;
    sessionId: string;
    idpSubject: string;
    audience: Audience;
    amr: readonly string[];
    authTime: number;
  },
): Promise<{ accessToken: string; jti: string }> {
  const now = Math.floor((env.now ?? Date.now)() / 1000);
  const jti = uuidv7();
  const amr = input.amr.filter((v) => v.length <= 32).slice(0, 16);
  const accessToken = await env.mint({
    iss: env.config.public_base_url.replace(/\/+$/, ''),
    aud: input.audience,
    sub: input.userId,
    client_id: CLI_CLIENT_ID,
    tid: env.config.org.id,
    sid: input.sessionId,
    idp_sub: input.idpSubject,
    surface: 'cli',
    ...(amr.length === 0 ? {} : { amr }),
    auth_time: input.authTime,
    region: env.config.org.region,
    token_use: 'access',
    iat: now,
    nbf: now,
    exp: now + env.config.tokens.access_ttl_s,
    jti,
  });
  return { accessToken, jti };
}

/**
 * Writes `auth.sign_in success` (with the directory events) FAIL-CLOSED. On failure the session
 * is revoked (`audit_unavailable`), the same events and the revocation are spooled, and the
 * returned error is thrown by the caller: no tokens leave RTS (§5.8).
 */
export interface SuccessRecord {
  actor: Actor;
  sessionId: string;
  roles: SessionRole[];
  adminRoleWithheld: boolean;
  /** directory.* events written with the success (flow A); flow B wrote them at the callback. */
  directoryEvents: StoredEventInput[];
}

export async function recordSuccess(
  attempt: SignInAttempt,
  authorized: SuccessRecord,
  details: Record<string, unknown>,
): Promise<OAuthProblem | undefined> {
  const { env } = attempt;
  const orgId = env.config.org.id;
  attempt.claimSuccess();
  const success = attempt.signInEvent('success', undefined, {
    actor: authorized.actor,
    sessionId: authorized.sessionId,
    details: {
      ...details,
      roles: authorized.roles,
      ...(authorized.adminRoleWithheld ? { admin_role_withheld: true } : {}),
    },
  });
  const events = [...authorized.directoryEvents, success];
  try {
    await env.writer.write(orgId, events);
    return undefined;
  } catch (error) {
    env.logger.error('sign_in_audit_unavailable', { error: String(error) });
    const sid = authorized.sessionId;
    const revoked = await env.store.revokeSession(sid, 'audit_unavailable').catch(() => false);
    const revocation = revoked
      ? [
          authEvent({
            action: 'auth.session.revoked',
            outcome: 'success',
            traceId: attempt.ctx.traceId,
            user: { id: authorized.actor.id, idpSubject: authorized.actor.idpSubject },
            sessionId: sid,
            details: { sid, revoked_by: 'system', cause: 'audit_unavailable' },
          }),
        ]
      : [];
    await env.writer.writeOrSpool(orgId, [...events, ...revocation]).catch(() => undefined);
    return new OAuthProblem(
      { error: 'temporarily_unavailable', error_description: 'audit unavailable' },
      503,
    );
  }
}

/** auth.session.revoked for a session the system revoked (§3.5; written only when it changed). */
export function sessionRevokedEvent(
  traceId: string,
  actor: Actor,
  sid: string,
  cause: string,
): StoredEventInput {
  return authEvent({
    action: 'auth.session.revoked',
    outcome: 'success',
    traceId,
    user: { id: actor.id, idpSubject: actor.idpSubject },
    sessionId: sid,
    details: { sid, revoked_by: 'system', cause },
  });
}

/** SHA-256 of the IdP token's `uti`: the replay key (§4.4 idp_token_replay). */
export const replayKey = (uti: string): Buffer => createHash('sha256').update(uti, 'utf8').digest();
