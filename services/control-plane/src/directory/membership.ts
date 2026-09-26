// The configured groups, the memberships Graph confirms, and the roles a session holds now
// (F-002 design §4.4, §6.1, §6.3; rev 10, #47, SEC-F002-42).
//
// - ensureConfiguredGroups: `cp.idp_group.role` follows config only. The two configured object
//   ids carry `access` and `platform_admin`; every other group carries none. Used at sign-in and
//   at `serve` start (reconcileGroupRoles), which audits what it changed.
// - recordGraphMembership: the Graph answer for the two configured groups replaces the user's
//   memberships of those two groups (`source = graph_check`). Sign-in writes it through
//   provision(); every refresh writes it here, so a removal in Entra reaches `Principal` at the
//   user's next refresh, not their next full sign-in.
// - sessionRoles: a session's roles ∩ the user's current memberships. The one rule for
//   privileged decisions: `GET /v1/internal/principals/{id}?sid=` (`session_roles`) and the audit
//   query use it. Directory roles alone never grant `platform_admin`: an admin who signed in by
//   device code has a session without it (SEC-F002-06).
import { uuidv7 } from '@ralysa/protocol/common';
import { type Transaction, sql } from 'kysely';
import type { SessionRole } from '../auth/sessions.js';
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

/** Sets `role` from config on every group; returns what changed (sorted by group id). */
export async function ensureConfiguredGroups(
  trx: Trx,
  orgId: string,
  configured: ConfiguredGroups,
): Promise<GroupRoleChange[]> {
  const { access, admin } = configured;
  const before = await trx
    .selectFrom('cp.idp_group')
    .select(['idp_group_id', 'role'])
    .where((eb) => eb.or([eb('role', 'is not', null), eb('idp_group_id', 'in', [access, admin])]))
    .forUpdate()
    .execute();
  const was = new Map(before.map((row) => [row.idp_group_id, row.role]));
  const desired = new Map<string, GroupRole>([
    [access, 'access'],
    [admin, 'platform_admin'],
  ]);

  await trx
    .updateTable('cp.idp_group')
    .set({ role: null })
    .where('role', 'is not', null)
    .where('idp_group_id', 'not in', [access, admin])
    .execute();
  for (const [idpGroupId, role] of desired) {
    await trx
      .insertInto('cp.idp_group')
      .values({
        id: uuidv7(),
        org_id: orgId,
        idp_group_id: idpGroupId,
        display_name: null,
        role,
        name_refreshed_at: null,
      })
      .onConflict((oc) => oc.columns(['org_id', 'idp_group_id']).doUpdateSet({ role }))
      .execute();
  }

  const changes: GroupRoleChange[] = [];
  for (const [idpGroupId, from] of was) {
    const to = desired.get(idpGroupId) ?? null;
    if (from !== to) changes.push({ idpGroupId, from, to });
  }
  for (const [idpGroupId, to] of desired) {
    if (!was.has(idpGroupId)) changes.push({ idpGroupId, from: null, to });
  }
  return changes.sort((a, b) => a.idpGroupId.localeCompare(b.idpGroupId));
}

/**
 * Writes Graph's answer for the two configured groups back to `cp.group_membership`
 * (`graph_check`): a group the user is in is upserted, one they left is deleted. Other groups
 * (token claims) are untouched. Returns the IdP object ids added and removed.
 */
export async function recordGraphMembership(
  trx: Trx,
  orgId: string,
  userId: string,
  configured: ConfiguredGroups,
  graph: { inAccessGroup: boolean; inAdminGroup: boolean },
): Promise<{ added: string[]; removed: string[] }> {
  const ids = [configured.access, configured.admin];
  // Normally present since `serve` start, which also owns existing rows' roles
  // (ensureConfiguredGroups); a missing row is created with its configured role.
  await trx
    .insertInto('cp.idp_group')
    .values(
      (
        [
          [configured.access, 'access'],
          [configured.admin, 'platform_admin'],
        ] as const
      ).map(([idpGroupId, role]) => ({
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
        .where('m.user_id', '=', userId)
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
        .values({ org_id: orgId, user_id: userId, group_id: groupId, source: 'graph_check' })
        .onConflict((oc) =>
          oc.columns(['org_id', 'user_id', 'group_id']).doUpdateSet({
            source: 'graph_check',
            observed_at: sql<Date>`clock_timestamp()`,
          }),
        )
        .execute();
      if (!held.has(idpGroupId)) added.push(idpGroupId);
    } else if (held.has(idpGroupId)) {
      await trx
        .deleteFrom('cp.group_membership')
        .where('user_id', '=', userId)
        .where('group_id', '=', groupId)
        .execute();
      removed.push(idpGroupId);
    }
  }
  return { added: [...new Set(added)].sort(), removed: [...new Set(removed)].sort() };
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
