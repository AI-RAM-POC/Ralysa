// The configured groups, the memberships Graph confirms, and the roles a session holds now
// (F-002 design §4.4, §6.1, §6.3; rev 10, #47, SEC-F002-42; review round 2, R58-1..4).
//
// - reconcileConfiguredGroups: `cp.idp_group.role` follows config, and only the `serve` start
//   changes it (reconcileGroupRoles audits each change). The two configured object ids carry
//   `access` and `platform_admin`; every other group carries none. Replicas starting together are
//   serialized by a per-org advisory lock, and only rows an UPDATE or INSERT actually changed are
//   reported, so each change is audited once (R58-1).
// - ensureConfiguredGroupRows: what sign-in may do. It creates a missing configured row and
//   changes no role. It returns the skew between stored roles and this replica's config, which
//   sign-in logs as `group_role_config_skew` (R58-3, SEC-F002-52).
// - recordGraphMembership: the Graph answer for the two configured groups replaces the user's
//   memberships of those two groups (`source = graph_check`). Every refresh writes it, so a
//   removal in Entra reaches `Principal` at the user's next refresh. Answers are ordered by when
//   their Graph call started (`app_user.graph_checked_at`), under a per-user advisory lock: an
//   older answer never overwrites a newer one (R58-4, SEC-F002-53).
// - sessionRoles: a session's roles ∩ the user's current memberships. The one rule for
//   privileged decisions: `GET /v1/internal/principals/{id}?sid=` (`session_roles`) and the audit
//   query use it. Directory roles alone never grant `platform_admin`: an admin who signed in by
//   device code has a session without it (SEC-F002-06).
import { uuidv7 } from '@ralysa/protocol/common';
import { type Kysely, type Transaction, sql } from 'kysely';
import type { SessionRole } from '../auth/sessions.js';
import { withOrg } from '../db/kysely.js';
import type { Database } from '../db/types.js';

type Trx = Transaction<Database>;
type GroupRole = 'access' | 'platform_admin';

export interface ConfiguredGroups {
  access: string;
  admin: string;
}

export interface GroupRoleChange {
  idpGroupId: string;
  from: GroupRole | null;
  to: GroupRole | null;
}

const desiredRoles = (configured: ConfiguredGroups) =>
  new Map<string, GroupRole>([
    [configured.access, 'access'],
    [configured.admin, 'platform_admin'],
  ]);

const byGroupId = (a: GroupRoleChange, b: GroupRoleChange) =>
  a.idpGroupId.localeCompare(b.idpGroupId);

/** The stored roles of every role-bearing or configured group. */
async function storedRoles(trx: Trx, configured: ConfiguredGroups) {
  const rows = await trx
    .selectFrom('cp.idp_group')
    .select(['idp_group_id', 'role'])
    .where((eb) =>
      eb.or([
        eb('role', 'is not', null),
        eb('idp_group_id', 'in', [configured.access, configured.admin]),
      ]),
    )
    .execute();
  return new Map(rows.map((row) => [row.idp_group_id, row.role]));
}

/**
 * `serve` start only: sets `role` from config on every group and returns the rows it actually
 * changed (sorted by group id). Serialized per org, so concurrent starts report each change once.
 */
export async function reconcileConfiguredGroups(
  trx: Trx,
  orgId: string,
  configured: ConfiguredGroups,
): Promise<GroupRoleChange[]> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`idp-group-roles|${orgId}`}, 0))`.execute(
    trx,
  );
  const was = await storedRoles(trx, configured);
  const desired = desiredRoles(configured);
  const changes: GroupRoleChange[] = [];

  const cleared = await trx
    .updateTable('cp.idp_group')
    .set({ role: null })
    .where('role', 'is not', null)
    .where('idp_group_id', 'not in', [...desired.keys()])
    .returning('idp_group_id')
    .execute();
  for (const row of cleared) {
    changes.push({
      idpGroupId: row.idp_group_id,
      from: was.get(row.idp_group_id) ?? null,
      to: null,
    });
  }
  for (const [idpGroupId, role] of desired) {
    // Only a row that is inserted, or whose role differs, comes back.
    const changed = await trx
      .insertInto('cp.idp_group')
      .values({
        id: uuidv7(),
        org_id: orgId,
        idp_group_id: idpGroupId,
        display_name: null,
        role,
        name_refreshed_at: null,
      })
      .onConflict((oc) =>
        oc
          .columns(['org_id', 'idp_group_id'])
          .doUpdateSet({ role })
          .where(sql<boolean>`idp_group.role is distinct from excluded.role`),
      )
      .returning('idp_group_id')
      .executeTakeFirst();
    if (changed !== undefined) {
      changes.push({ idpGroupId, from: was.get(idpGroupId) ?? null, to: role });
    }
  }
  return changes.sort(byGroupId);
}

/**
 * Sign-in: creates a missing configured group row (with its configured role) and changes no
 * existing role. Returns how the stored roles differ from this config (empty when they agree).
 */
export async function ensureConfiguredGroupRows(
  trx: Trx,
  orgId: string,
  configured: ConfiguredGroups,
): Promise<GroupRoleChange[]> {
  const desired = desiredRoles(configured);
  await trx
    .insertInto('cp.idp_group')
    .values(
      [...desired].map(([idpGroupId, role]) => ({
        id: uuidv7(),
        org_id: orgId,
        idp_group_id: idpGroupId,
        display_name: null,
        role,
        name_refreshed_at: null,
      })),
    )
    .onConflict((oc) => oc.columns(['org_id', 'idp_group_id']).doNothing())
    .execute();
  const skew: GroupRoleChange[] = [];
  for (const [idpGroupId, from] of await storedRoles(trx, configured)) {
    const to = desired.get(idpGroupId) ?? null;
    if (from !== to) skew.push({ idpGroupId, from, to });
  }
  return skew.sort(byGroupId);
}

/**
 * One writer of a user's Graph answers at a time (refresh write-back, sign-in provisioning),
 * keyed by the IdP subject, which both know before touching the user's row.
 */
export async function lockGraphMembership(
  trx: Trx,
  orgId: string,
  idpSubject: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`graph-membership|${orgId}|${idpSubject}`}, 0))`.execute(
    trx,
  );
}

/** The database clock, read just before a Graph call: the answer's place in the order. */
export async function graphCheckTime(db: Kysely<Database>, orgId: string): Promise<Date> {
  const row = await withOrg(
    db,
    orgId,
    async (trx) => (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0],
    { readOnly: true },
  );
  if (row === undefined) throw new Error('clock_timestamp() returned no row');
  return row.now;
}

/**
 * Writes Graph's answer for the two configured groups back to `cp.group_membership`
 * (`graph_check`): a group the user is in is upserted, one they left is deleted. Other groups
 * (token claims) are untouched. `checkedAt` is when this answer's Graph call started; an answer
 * older than the stored `graph_checked_at` is skipped (`stale: true`, nothing written).
 */
export async function recordGraphMembership(
  trx: Trx,
  orgId: string,
  user: { id: string; idpSubject: string },
  configured: ConfiguredGroups,
  graph: { inAccessGroup: boolean; inAdminGroup: boolean },
  checkedAt: Date,
): Promise<{ added: string[]; removed: string[]; stale: boolean }> {
  await lockGraphMembership(trx, orgId, user.idpSubject);
  const stored = await trx
    .selectFrom('cp.app_user')
    .select('graph_checked_at')
    .where('id', '=', user.id)
    .executeTakeFirst();
  const storedAt = stored?.graph_checked_at ?? null;
  if (storedAt !== null && storedAt > checkedAt) {
    return { added: [], removed: [], stale: true };
  }
  const ids = [configured.access, configured.admin];
  // Normally present since `serve` start, which owns existing rows' roles; a missing row is
  // created with its configured role (as at sign-in).
  await ensureConfiguredGroupRows(trx, orgId, configured);
  const groups = await trx
    .selectFrom('cp.idp_group')
    .select(['id', 'idp_group_id'])
    .where('idp_group_id', 'in', ids)
    .execute();
  const rowOf = new Map(groups.map((g) => [g.idp_group_id, g.id]));
  const held = new Set(
    (
      await trx
        .selectFrom('cp.group_membership as m')
        .innerJoin('cp.idp_group as g', 'g.id', 'm.group_id')
        .select('g.idp_group_id')
        .where('m.user_id', '=', user.id)
        .where('g.idp_group_id', 'in', ids)
        .execute()
    ).map((row) => row.idp_group_id),
  );
  const inGroup = new Map([
    [configured.access, graph.inAccessGroup],
    [configured.admin, graph.inAdminGroup],
  ]);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [idpGroupId, member] of inGroup) {
    const groupId = rowOf.get(idpGroupId);
    if (groupId === undefined) throw new Error('configured idp_group row missing');
    if (member) {
      await trx
        .insertInto('cp.group_membership')
        .values({
          org_id: orgId,
          user_id: user.id,
          group_id: groupId,
          source: 'graph_check',
          observed_at: checkedAt,
        })
        .onConflict((oc) =>
          oc
            .columns(['org_id', 'user_id', 'group_id'])
            .doUpdateSet({ source: 'graph_check', observed_at: checkedAt }),
        )
        .execute();
      if (!held.has(idpGroupId)) added.push(idpGroupId);
    } else if (held.has(idpGroupId)) {
      await trx
        .deleteFrom('cp.group_membership')
        .where('user_id', '=', user.id)
        .where('group_id', '=', groupId)
        .execute();
      removed.push(idpGroupId);
    }
  }
  await trx
    .updateTable('cp.app_user')
    .set({ graph_checked_at: checkedAt })
    .where('id', '=', user.id)
    .execute();
  return { added: [...new Set(added)].sort(), removed: [...new Set(removed)].sort(), stale: false };
}

/** The directory roles the group roles give (`access` → `user`). */
export function directoryRoles(groupRoles: readonly (GroupRole | null)[]): SessionRole[] {
  return [
    ...(groupRoles.includes('access') ? (['user'] as const) : []),
    ...(groupRoles.includes('platform_admin') ? (['platform_admin'] as const) : []),
  ];
}

/** A session's roles that the user's current memberships still back. */
export function intersectRoles(
  session: readonly SessionRole[],
  groupRoles: readonly (GroupRole | null)[],
): SessionRole[] {
  const backed = new Set(directoryRoles(groupRoles));
  return session.filter((role) => backed.has(role));
}

/**
 * The session's roles ∩ current memberships, or undefined when the session is unknown, belongs to
 * another user, is not active or has passed its absolute expiry (the caller refuses it). A
 * disabled user's live session (a race with revocation) holds no roles.
 */
export async function sessionRoles(
  trx: Trx,
  userId: string,
  sessionId: string,
): Promise<SessionRole[] | undefined> {
  const session = await trx
    .selectFrom('cp.auth_session as s')
    .innerJoin('cp.app_user as u', 'u.id', 's.user_id')
    .select(['s.roles', 'u.status'])
    .where('s.id', '=', sessionId)
    .where('s.user_id', '=', userId)
    .where('s.status', '=', 'active')
    .where(sql<boolean>`s.absolute_expires_at > clock_timestamp()`)
    .executeTakeFirst();
  if (session === undefined) return undefined;
  if (session.status !== 'active') return [];
  const groups = await trx
    .selectFrom('cp.group_membership as m')
    .innerJoin('cp.idp_group as g', 'g.id', 'm.group_id')
    .select('g.role')
    .where('m.user_id', '=', userId)
    .where('g.role', 'is not', null)
    .execute();
  return intersectRoles(
    session.roles,
    groups.map((g) => g.role),
  );
}
