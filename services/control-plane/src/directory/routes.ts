// GET /v1/me (user token) and GET /v1/internal/principals/:user_id[?sid=] (service token)
// (F-002 design §3.4.2, §6.1; AC-1, AC-7, AC-15; rev 10, #47). Display names are returned
// byte-for-byte as stored (UTF-8, Arabic unchanged). /v1/me reports the CALLING session's roles
// (decided at sign-in, §6.1). A principal's `roles` are directory roles from its current group
// memberships (a disabled user has none); they are never enough for `platform_admin`. With `?sid=`
// the answer adds `session_roles`, that session's roles ∩ the current memberships, which is what a
// PEP authorizes a privileged action on (SEC-F002-42); an unknown, revoked, expired or another
// user's session is refused with 403. The user token is checked against revocation read from the
// database [SEC-F002-18 d].
import type { FastifyInstance } from 'fastify';
import { type Transaction, sql } from 'kysely';
import { z } from 'zod';
import type { RtsDeps } from '../auth/deps.js';
import { authenticate } from '../auth/route-auth.js';
import { withOrg } from '../db/kysely.js';
import type { Database } from '../db/types.js';
import { ROUTES } from '../http/contracts.js';
import { HttpProblem } from '../http/errors.js';
import { directoryRoles, sessionRoles } from './membership.js';

const groupsOf = (trx: Transaction<Database>, userId: string) =>
  trx
    .selectFrom('cp.group_membership as m')
    .innerJoin('cp.idp_group as g', 'g.id', 'm.group_id')
    .select(['g.id', 'g.idp_group_id', 'g.display_name', 'g.role'])
    .where('m.user_id', '=', userId)
    .orderBy('g.idp_group_id')
    .execute();

export function registerDirectoryRoutes(app: FastifyInstance, deps: RtsDeps): void {
  app.get(
    ROUTES.me.url,
    { schema: { response: { 200: ROUTES.me.responses[200].schema } } },
    async (request) => {
      const claims = await authenticate(deps, request, 'user');
      const found = await withOrg(
        deps.db,
        deps.config.org.id,
        async (trx) => {
          const user = await trx
            .selectFrom('cp.app_user')
            .select(['id', 'org_id', 'idp_subject', 'email', 'display_name', 'locale', 'status'])
            .where('id', '=', claims.userId)
            .executeTakeFirst();
          const session = await trx
            .selectFrom('cp.auth_session')
            .select('roles')
            .where('id', '=', claims.sessionId)
            .executeTakeFirst();
          if (user === undefined || session === undefined) return undefined;
          return { ...user, roles: session.roles, groups: await groupsOf(trx, user.id) };
        },
        { readOnly: true },
      );
      if (found === undefined) throw new HttpProblem('not_found');
      return found;
    },
  );

  app.get(
    ROUTES.principal.url,
    { schema: { response: { 200: ROUTES.principal.responses[200].schema } } },
    async (request) => {
      await authenticate(deps, request, 'service');
      const userId = z.uuid().safeParse((request.params as { user_id?: unknown }).user_id);
      const sid = z
        .uuid()
        .optional()
        .safeParse((request.query as { sid?: unknown } | undefined)?.sid);
      if (!userId.success || !sid.success) throw new HttpProblem('invalid_request');
      const sessionId = sid.data?.toLowerCase();
      const found = await withOrg(
        deps.db,
        deps.config.org.id,
        async (trx) => {
          const user = await trx
            .selectFrom('cp.app_user')
            .select(['id', 'org_id', 'status', sql<Date>`clock_timestamp()`.as('as_of')])
            .where('id', '=', userId.data)
            .executeTakeFirst();
          if (user === undefined) return undefined;
          return {
            user,
            groups: await groupsOf(trx, user.id),
            session:
              sessionId === undefined
                ? undefined
                : { roles: await sessionRoles(trx, user.id, sessionId) },
          };
        },
        { readOnly: true },
      );
      if (found === undefined) throw new HttpProblem('not_found');
      const { user, groups, session } = found;
      // Refused, never answered with roles: an unknown or another user's sid, or a session that
      // is revoked, pending or past its absolute expiry.
      if (session !== undefined && session.roles === undefined) throw new HttpProblem('forbidden');
      const active = user.status === 'active';
      return {
        user_id: user.id,
        org_id: user.org_id,
        status: user.status,
        roles: active ? directoryRoles(groups.map((g) => g.role)) : [],
        groups: groups.map((g) => ({ idp_group_id: g.idp_group_id, role: g.role })),
        as_of: user.as_of.toISOString(),
        ...(session?.roles === undefined || sessionId === undefined
          ? {}
          : { session_id: sessionId, session_roles: active ? session.roles : [] }),
      };
    },
  );
}
