// Persistence for sign-in (F-002 design §3.2.5 step 4, §4.4, §6.3; SEC-F002-07, -08). A port, so
// the sign-in exits can be enumerated in a hermetic unit test; the Postgres implementation runs
// every step through withOrg as ralysa_cp_app.
//
// - The IdP-token replay key is inserted and COMMITTED ON ITS OWN before anything else can fail,
//   so every exchange attempt burns the IdP token whatever its outcome [SEC-F002-07].
// - provision() is one transaction: upsert the user by (issuer, oid), mirror the configured groups
//   (roles from config only) and the token's GUID groups, replace the user's memberships, store
//   group display names fetched for display, and create the session (plus its first refresh
//   token for flow A). A denied sign-in never reaches it: no user record, no session (AC-5).
import { uuidv7 } from '@ralysa/protocol/common';
import { type Kysely, type Transaction, sql } from 'kysely';
import { withOrg } from '../db/kysely.js';
import type { Database } from '../db/types.js';
import {
  type GroupRoleChange,
  ensureConfiguredGroupRows,
  lockGraphMembership,
} from '../directory/membership.js';
import type { SignInFlow } from './identity-mapping.js';
import {
  type CodeBinding,
  type CodeRedemption,
  type SessionRole,
  activatePendingSession,
  createAuthorizationCode,
  createSession,
  issueRefreshToken,
  redeemAuthorizationCode,
  revokeSession,
  revokeUser,
} from './sessions.js';

export const GROUP_NAME_REFRESH_MS = 24 * 60 * 60 * 1000;
export const GROUP_NAMES_PER_SIGN_IN = 20;
/** Replay keys outlive the IdP token by 5 minutes (§4.4). */
export const REPLAY_MARGIN_S = 300;

export interface ProvisionInput {
  issuer: string;
  tenantId: string;
  oid: string;
  email: string | null;
  displayName: string | null;
  /** Display names read from the IdP now (idp group id → name, or null for none). */
  groupNames: ReadonlyMap<string, string | null>;
  /** The memberships to hold after this sign-in (idp group object ids). */
  membership: readonly { idpGroupId: string; source: 'token_claim' | 'graph_check' }[];
  /**
   * false when the token carried no usable group list (overage, or no `groups` claim): only the
   * Graph-checked memberships are replaced, and earlier `token_claim` rows are kept, since the
   * token says nothing about them (review of #29, R29-4).
   */
  claimsKnown: boolean;
  configured: { access: string; admin: string };
  session: {
    flow: SignInFlow;
    status: 'active' | 'pending';
    roles: SessionRole[];
    clientId: string;
    surface: 'cli';
    deviceLabel: string | null;
    createdIp: string | null;
  };
  absoluteSeconds: number;
  idleSeconds: number;
  /** Flow A issues the first refresh token now; flow B at code redemption. */
  issueRefreshToken: boolean;
}

export interface ProvisionResult {
  userId: string;
  created: boolean;
  /** Names of the attributes that changed (never values). */
  changedAttributes: string[];
  /** IdP group object ids added to / removed from the user's memberships. */
  added: string[];
  removed: string[];
  /**
   * How the stored group roles differ from this replica's config (empty when they agree). Sign-in
   * never changes a role; the caller logs `group_role_config_skew` (R58-3, SEC-F002-52).
   */
  roleSkew: GroupRoleChange[];
  sessionId: string;
  refreshToken?: string;
}

/** A flow-B request between /oauth2/authorize and the IdP callback (§4.4 idp_auth_request). */
export interface AuthRequest {
  stateHash: Buffer;
  browserBindingHash: Buffer;
  clientRedirectUri: string;
  clientState: string;
  clientCodeChallenge: string;
  authorizeIp: string | null;
  idpCodeVerifier: string;
  idpNonce: string;
}

export interface SessionOwner {
  userId: string;
  idpSubject: string;
  roles: SessionRole[];
  status: 'pending' | 'active' | 'revoked';
}

export interface SignInStore {
  /** Inserts the replay key and commits it; false when it was already there (a replay). */
  consumeIdpToken(tokenIdHash: Buffer, expiresAtEpochS: number): Promise<boolean>;
  findUser(
    issuer: string,
    oid: string,
  ): Promise<{ id: string; status: 'active' | 'disabled' } | undefined>;
  /** Revokes everything the user holds (and disables them); returns the sessions revoked. */
  revokeUser(userId: string, reason: string, disable: boolean): Promise<number>;
  revokeSession(sessionId: string, reason: string): Promise<boolean>;
  /** Of `ids`, those whose display name is unknown or older than a day (at most 20). */
  groupsNeedingNames(ids: readonly string[]): Promise<string[]>;
  provision(input: ProvisionInput): Promise<ProvisionResult>;

  // Flow B (§3.3, §5.2).
  /** Stores a request for `ttlSeconds` (10 min). */
  saveAuthRequest(request: AuthRequest, ttlSeconds: number): Promise<void>;
  /** Consumes the request atomically (DELETE … RETURNING) [SEC-F002-20]; `live` = not expired. */
  consumeAuthRequest(stateHash: Buffer): Promise<(AuthRequest & { live: boolean }) | undefined>;
  createCode(input: {
    code: string;
    sessionId: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    callbackIp: string | null;
    ttlSeconds: number;
    signIn: Record<string, unknown>;
  }): Promise<void>;
  redeemCode(code: string, binding: CodeBinding): Promise<CodeRedemption>;
  sessionOwner(sessionId: string): Promise<SessionOwner | undefined>;
  /** Activates a pending session and issues its first refresh token; undefined if not pending. */
  activateSession(sessionId: string, idleSeconds: number): Promise<string | undefined>;
}

type Trx = Transaction<Database>;

async function upsertUser(
  trx: Trx,
  orgId: string,
  input: ProvisionInput,
): Promise<{ id: string; created: boolean; changed: string[] }> {
  const find = () =>
    trx
      .selectFrom('cp.app_user')
      .select(['id', 'email', 'display_name', 'status'])
      .where('idp_issuer', '=', input.issuer)
      .where('idp_subject', '=', input.oid)
      .forUpdate()
      .executeTakeFirst();
  let existing = await find();
  if (existing === undefined) {
    const inserted = await trx
      .insertInto('cp.app_user')
      .values({
        id: uuidv7(),
        org_id: orgId,
        idp_issuer: input.issuer,
        idp_tenant_id: input.tenantId,
        idp_subject: input.oid,
        email: input.email,
        display_name: input.displayName,
        department_id: null,
        revoked_before: null,
        last_sign_in_at: sql<Date>`clock_timestamp()`,
      })
      .onConflict((oc) => oc.columns(['org_id', 'idp_issuer', 'idp_subject']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted !== undefined) return { id: inserted.id, created: true, changed: [] };
    existing = await find(); // a concurrent first sign-in of the same user won the insert
    if (existing === undefined) throw new Error('app_user vanished during sign-in');
  }
  const changed = [
    ...(existing.email === input.email ? [] : ['email']),
    ...(existing.display_name === input.displayName ? [] : ['display_name']),
    ...(existing.status === 'active' ? [] : ['status']),
  ];
  await trx
    .updateTable('cp.app_user')
    .set({
      email: input.email,
      display_name: input.displayName,
      status: 'active',
      last_sign_in_at: sql<Date>`clock_timestamp()`,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .where('id', '=', existing.id)
    .execute();
  return { id: existing.id, created: false, changed };
}

async function syncGroups(
  trx: Trx,
  orgId: string,
  userId: string,
  input: ProvisionInput,
): Promise<{ added: string[]; removed: string[]; roleSkew: GroupRoleChange[] }> {
  const { access, admin } = input.configured;
  // Roles come from config, and only the audited `serve` start changes them: sign-in creates a
  // missing configured row and reports any skew, never rewriting a role (R58-3, SEC-F002-52).
  const roleSkew = await ensureConfiguredGroupRows(trx, orgId, input.configured);
  const others = [...new Set(input.membership.map((m) => m.idpGroupId))].filter(
    (id) => id !== access && id !== admin,
  );
  if (others.length > 0) {
    await trx
      .insertInto('cp.idp_group')
      .values(
        others.map((idpGroupId) => ({
          id: uuidv7(),
          org_id: orgId,
          idp_group_id: idpGroupId,
          display_name: null,
          role: null,
          name_refreshed_at: null,
        })),
      )
      .onConflict((oc) => oc.columns(['org_id', 'idp_group_id']).doNothing())
      .execute();
  }
  for (const [idpGroupId, name] of input.groupNames) {
    await trx
      .updateTable('cp.idp_group')
      .set({ display_name: name, name_refreshed_at: sql<Date>`clock_timestamp()` })
      .where('idp_group_id', '=', idpGroupId)
      .execute();
  }

  const desired = new Map(input.membership.map((m) => [m.idpGroupId, m.source]));
  const current = await trx
    .selectFrom('cp.group_membership as m')
    .innerJoin('cp.idp_group as g', 'g.id', 'm.group_id')
    .select(['g.id as groupId', 'g.idp_group_id as idpGroupId', 'm.source as source'])
    .where('m.user_id', '=', userId)
    .execute();
  const removed = current.filter(
    (c) => !desired.has(c.idpGroupId) && (input.claimsKnown || c.source === 'graph_check'),
  );
  if (removed.length > 0) {
    await trx
      .deleteFrom('cp.group_membership')
      .where('user_id', '=', userId)
      .where(
        'group_id',
        'in',
        removed.map((r) => r.groupId),
      )
      .execute();
  }
  const held = new Set(current.map((c) => c.idpGroupId));
  if (desired.size > 0) {
    const rows = await trx
      .selectFrom('cp.idp_group')
      .select(['id', 'idp_group_id'])
      .where('idp_group_id', 'in', [...desired.keys()])
      .execute();
    await trx
      .insertInto('cp.group_membership')
      .values(
        rows.map((row) => ({
          org_id: orgId,
          user_id: userId,
          group_id: row.id,
          source: desired.get(row.idp_group_id) ?? 'token_claim',
        })),
      )
      .onConflict((oc) =>
        oc.columns(['org_id', 'user_id', 'group_id']).doUpdateSet((eb) => ({
          source: eb.ref('excluded.source'),
          observed_at: sql<Date>`clock_timestamp()`,
        })),
      )
      .execute();
  }
  // This sign-in's Graph answer is the newest at its write: a refresh whose Graph call started
  // earlier is skipped by recordGraphMembership (R58-4).
  await trx
    .updateTable('cp.app_user')
    .set({ graph_checked_at: sql<Date>`greatest(graph_checked_at, clock_timestamp())` })
    .where('id', '=', userId)
    .execute();
  return {
    added: [...desired.keys()].filter((id) => !held.has(id)).sort(),
    removed: removed.map((r) => r.idpGroupId).sort(),
    roleSkew,
  };
}

export function createSignInStore(db: Kysely<Database>, orgId: string): SignInStore {
  return {
    async consumeIdpToken(tokenIdHash, expiresAtEpochS) {
      const inserted = await withOrg(db, orgId, (trx) =>
        trx
          .insertInto('cp.idp_token_replay')
          .values({
            token_id_hash: tokenIdHash,
            org_id: orgId,
            expires_at: sql<Date>`to_timestamp(${expiresAtEpochS}) + make_interval(secs => ${REPLAY_MARGIN_S})`,
          })
          .onConflict((oc) => oc.column('token_id_hash').doNothing())
          .returning('token_id_hash')
          .executeTakeFirst(),
      );
      return inserted !== undefined;
    },

    findUser: (issuer, oid) =>
      withOrg(
        db,
        orgId,
        (trx) =>
          trx
            .selectFrom('cp.app_user')
            .select(['id', 'status'])
            .where('idp_issuer', '=', issuer)
            .where('idp_subject', '=', oid)
            .executeTakeFirst(),
        { readOnly: true },
      ),

    revokeUser: (userId, reason, disable) =>
      withOrg(db, orgId, (trx) => revokeUser(trx, userId, reason, { disable })),

    revokeSession: (sessionId, reason) =>
      withOrg(db, orgId, (trx) => revokeSession(trx, sessionId, reason)),

    async groupsNeedingNames(ids) {
      if (ids.length === 0) return [];
      const known = await withOrg(
        db,
        orgId,
        (trx) =>
          trx
            .selectFrom('cp.idp_group')
            .select('idp_group_id')
            .where('idp_group_id', 'in', [...ids])
            .where(
              sql<boolean>`name_refreshed_at > clock_timestamp() - make_interval(secs => ${GROUP_NAME_REFRESH_MS / 1000})`,
            )
            .execute(),
        { readOnly: true },
      );
      const fresh = new Set(known.map((k) => k.idp_group_id));
      return ids.filter((id) => !fresh.has(id)).slice(0, GROUP_NAMES_PER_SIGN_IN);
    },

    async saveAuthRequest(request, ttlSeconds) {
      await withOrg(db, orgId, (trx) =>
        trx
          .insertInto('cp.idp_auth_request')
          .values({
            state_hash: request.stateHash,
            org_id: orgId,
            browser_binding_hash: request.browserBindingHash,
            client_redirect_uri: request.clientRedirectUri,
            client_state: request.clientState,
            client_code_challenge: request.clientCodeChallenge,
            authorize_ip: request.authorizeIp,
            idp_code_verifier: request.idpCodeVerifier,
            idp_nonce: request.idpNonce,
            expires_at: sql<Date>`clock_timestamp() + make_interval(secs => ${ttlSeconds})`,
          })
          .execute(),
      );
    },

    async consumeAuthRequest(stateHash) {
      const row = await withOrg(db, orgId, (trx) =>
        trx
          .deleteFrom('cp.idp_auth_request')
          .where('state_hash', '=', stateHash)
          .returning([
            'state_hash',
            'browser_binding_hash',
            'client_redirect_uri',
            'client_state',
            'client_code_challenge',
            'authorize_ip',
            'idp_code_verifier',
            'idp_nonce',
            sql<boolean>`expires_at > clock_timestamp()`.as('live'),
          ])
          .executeTakeFirst(),
      );
      if (row === undefined) return undefined;
      return {
        stateHash: Buffer.from(row.state_hash),
        browserBindingHash: Buffer.from(row.browser_binding_hash),
        clientRedirectUri: row.client_redirect_uri,
        clientState: row.client_state,
        clientCodeChallenge: row.client_code_challenge,
        authorizeIp: row.authorize_ip,
        idpCodeVerifier: row.idp_code_verifier,
        idpNonce: row.idp_nonce,
        live: row.live,
      };
    },

    createCode: (input) =>
      withOrg(db, orgId, (trx) => createAuthorizationCode(trx, { orgId, ...input })),

    redeemCode: (code, binding) =>
      withOrg(db, orgId, (trx) => redeemAuthorizationCode(trx, code, binding)),

    sessionOwner: (sessionId) =>
      withOrg(
        db,
        orgId,
        (trx) =>
          trx
            .selectFrom('cp.auth_session as s')
            .innerJoin('cp.app_user as u', 'u.id', 's.user_id')
            .select([
              'u.id as userId',
              'u.idp_subject as idpSubject',
              's.roles as roles',
              's.status as status',
            ])
            .where('s.id', '=', sessionId)
            .executeTakeFirst(),
        { readOnly: true },
      ),

    async activateSession(sessionId, idleSeconds) {
      const issued = await withOrg(db, orgId, (trx) =>
        activatePendingSession(trx, { orgId, sessionId, idleSeconds }),
      );
      return issued?.token;
    },

    provision: (input) =>
      withOrg(db, orgId, async (trx) => {
        // Before the user's row is touched, as the refresh write-back does (no lock-order cycle).
        await lockGraphMembership(trx, orgId, input.oid);
        const user = await upsertUser(trx, orgId, input);
        const groups = await syncGroups(trx, orgId, user.id, input);
        const sessionId = await createSession(trx, {
          orgId,
          userId: user.id,
          clientId: input.session.clientId,
          surface: input.session.surface,
          flow: input.session.flow,
          status: input.session.status,
          roles: input.session.roles,
          deviceLabel: input.session.deviceLabel,
          createdIp: input.session.createdIp,
          absoluteSeconds: input.absoluteSeconds,
        });
        const refresh = input.issueRefreshToken
          ? await issueRefreshToken(trx, {
              orgId,
              sessionId,
              parentId: null,
              idleSeconds: input.idleSeconds,
            })
          : undefined;
        return {
          userId: user.id,
          created: user.created,
          changedAttributes: user.changed,
          added: groups.added,
          removed: groups.removed,
          roleSkew: groups.roleSkew,
          sessionId,
          ...(refresh === undefined ? {} : { refreshToken: refresh.token }),
        };
      }),
  };
}
