// GET /v1/me (user token) and GET /v1/internal/principals/:user_id (service token)
// (F-002 design §3.4.2; AC-1, AC-7, AC-15). Display names are returned byte-for-byte as stored
// (UTF-8, Arabic unchanged). /v1/me reports the CALLING session's roles (decided at sign-in,
// §6.1); a principal's roles come from its current group memberships, and a disabled user has
// none. The user token is checked against revocation read from the database [SEC-F002-18 d].
import type { FastifyInstance } from 'fastify';
import { type Transaction, sql } from 'kysely';
import { z } from 'zod';
import type { RtsDeps } from '../auth/deps.js';
import { authenticate } from '../auth/route-auth.js';
import { withOrg } from '../db/kysely.js';
import type { Database } from '../db/types.js';
import { ROUTES } from '../http/contracts.js';
import { HttpProblem } from '../http/errors.js';

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
      if (!userId.success) throw new HttpProblem('invalid_request');
      const found = await withOrg(
        deps.db,
        deps.config.org.id,
        async (trx) => {
          const user = await trx
            .selectFrom('cp.app_user')
            .select(['id', 'org_id', 'status', sql<Date>`clock_timestamp()`.as('as_of')])
            .where('id', '=', userId.data)
            .executeTakeFirst();
          return user === undefined ? undefined : { user, groups: await groupsOf(trx, user.id) };
        },
        { readOnly: true },
      );
      if (found === undefined) throw new HttpProblem('not_found');
      const { user, groups } = found;
      const roles = [
        ...(groups.some((g) => g.role === 'access') ? (['user'] as const) : []),
        ...(groups.some((g) => g.role === 'platform_admin') ? (['platform_admin'] as const) : []),
      ];
      return {
        user_id: user.id,
        org_id: user.org_id,
        status: user.status,
        roles: user.status === 'active' ? roles : [],
        groups: groups.map((g) => ({ idp_group_id: g.idp_group_id, role: g.role })),
        as_of: user.as_of.toISOString(),
      };
    },
  );
}
