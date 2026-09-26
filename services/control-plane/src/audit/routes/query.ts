// GET /v1/audit/events: the audit query (F-002 design §3.4.6, §6.1; AC-12; SEC-F002-06 c; TM-49).
//
// - `from` and `to` are required, at most 31 days apart; `limit` ≤ 500 (default 100); keyset
//   pagination on (ts, event_id) with an opaque cursor; filters `user_id`, `action`, `outcome`.
// - It needs the SESSION role `platform_admin` (decided at sign-in on a strong flow, §6.1), read
//   from cp.auth_session for the token's `sid` at request time, AND a current membership of the
//   admin group.
// - Allowed: `audit.query success` (the filters, the policy version) is written and COMMITTED
//   before any result is read; if that write fails the answer is 503 `audit_unavailable`
//   [SEC-F002-06 c]. Each event carries its seal (`shard`, `seq`) when sealed.
// - Not admin: 403, after `audit.query denied not_platform_admin` (a denial stands even when its
//   own write fails, ADR-0022 rule 5, so it is spooled).
// - Reads use ralysa_audit_reader under RLS, in a READ ONLY transaction.
import { uuidv7 } from '@ralysa/protocol/common';
import { AUDIT_QUERY_MAX_RANGE_DAYS, AuditQuery } from '@ralysa/protocol/control-plane';
import type { VerifiedPrincipal } from '@ralysa/auth';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { RtsDeps } from '../../auth/deps.js';
import { authenticate } from '../../auth/route-auth.js';
import { withOrg } from '../../db/kysely.js';
import { sessionRoles } from '../../directory/membership.js';
import { ROUTES } from '../../http/contracts.js';
import { HttpProblem } from '../../http/errors.js';
import type { StoredEventInput } from '../columns.js';
import { rowToEnvelope } from '../sealer/chain.js';
import { AuditUnavailableError } from '../writer.js';

export const AUDIT_QUERY_DEFAULT_LIMIT = 100;
const MAX_RANGE_MS = AUDIT_QUERY_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

const Cursor = z.tuple([z.iso.datetime({ precision: 3 }), z.uuid()]);

export function encodeCursor(ts: string, eventId: string): string {
  return Buffer.from(JSON.stringify([ts, eventId])).toString('base64url');
}

export function decodeCursor(value: string): [string, string] | undefined {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) return undefined;
  try {
    const parsed = Cursor.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

interface Filters {
  from: string;
  to: string;
  user_id?: string;
  action?: string;
  outcome?: string;
  limit: number;
  cursor?: boolean;
}

function queryEvent(
  deps: RtsDeps,
  request: FastifyRequest,
  principal: VerifiedPrincipal,
  filters: Filters | { invalid: true },
  allowed: boolean,
): StoredEventInput {
  return {
    event_id: uuidv7(),
    action: 'audit.query',
    actor: {
      type: 'user',
      user_id: principal.userId,
      idp_subject: principal.idpSubject,
      service: null,
    },
    surface: principal.surface,
    outcome: allowed ? 'success' : 'denied',
    reason_code: allowed ? null : 'not_platform_admin',
    session_id: principal.sessionId,
    trace_id: request.traceId,
    policy_version: deps.policyVersion,
    details: { filters: { ...filters } },
    source: 'control-plane',
    attestation: 'server',
  };
}

/**
 * The session role and a current admin-group membership, at request time (§6.1): the same rule
 * as `session_roles` on the principals route (directory/membership.ts, #47).
 */
async function isPlatformAdmin(deps: RtsDeps, principal: VerifiedPrincipal): Promise<boolean> {
  const roles = await withOrg(
    deps.db,
    principal.orgId,
    (trx) => sessionRoles(trx, principal.userId, principal.sessionId),
    { readOnly: true },
  );
  return roles?.includes('platform_admin') === true;
}

/** The parsed query, or undefined when it is invalid (400 for an admin). */
function validateQuery(raw: unknown) {
  const parsed = AuditQuery.safeParse(raw);
  if (!parsed.success) return undefined;
  const query = parsed.data;
  const from = new Date(query.from);
  const to = new Date(query.to);
  if (!(from < to) || to.getTime() - from.getTime() > MAX_RANGE_MS) return undefined;
  const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  if (query.cursor !== undefined && after === undefined) return undefined;
  const limit = query.limit === undefined ? AUDIT_QUERY_DEFAULT_LIMIT : Number(query.limit);
  const filters: Filters = {
    from: from.toISOString(),
    to: to.toISOString(),
    ...(query.user_id === undefined ? {} : { user_id: query.user_id }),
    ...(query.action === undefined ? {} : { action: query.action }),
    ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
    limit,
    ...(after === undefined ? {} : { cursor: true }),
  };
  return { query, from, to, after, limit, filters };
}

export function registerAuditQuery(app: FastifyInstance, deps: RtsDeps): void {
  app.get(
    ROUTES.auditQuery.url,
    { schema: { response: { 200: ROUTES.auditQuery.responses[200].schema } } },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const principal = await authenticate(deps, request, 'user');
      const valid = validateQuery(request.query);
      // The role first: a non-admin is refused (and audited) whatever the parameters, so the
      // answer never tells a non-admin which filters are valid (review of #33, R33-8).
      if (!(await isPlatformAdmin(deps, principal))) {
        try {
          await deps.writer.writeOrSpool(principal.orgId, [
            queryEvent(deps, request, principal, valid?.filters ?? { invalid: true }, false),
          ]);
        } catch (error) {
          deps.logger.warn('audit_query_denial_write_failed', { error: String(error) });
        }
        throw new HttpProblem('forbidden');
      }
      if (valid === undefined) throw new HttpProblem('invalid_request');
      const { query, from, to, after, limit, filters } = valid;
      const reader = deps.auditReader;
      if (reader === undefined) throw new HttpProblem('temporarily_unavailable');
      // Written and committed before any result is read [SEC-F002-06 c].
      try {
        await deps.writer.write(principal.orgId, [
          queryEvent(deps, request, principal, filters, true),
        ]);
      } catch (error) {
        if (error instanceof AuditUnavailableError) throw new HttpProblem('audit_unavailable');
        throw error;
      }

      const rows = await withOrg(
        reader,
        principal.orgId,
        async (trx) => {
          let q = trx
            .selectFrom('audit.audit_event as e')
            .leftJoin('audit.audit_seal as s', 's.event_id', 'e.event_id')
            .selectAll('e')
            .select(['s.shard as seal_shard', 's.seq as seal_seq'])
            .where('e.ts', '>=', from)
            .where('e.ts', '<', to);
          if (query.user_id !== undefined) q = q.where('e.actor_user_id', '=', query.user_id);
          if (query.action !== undefined) q = q.where('e.action', '=', query.action);
          if (query.outcome !== undefined) q = q.where('e.outcome', '=', query.outcome);
          if (after !== undefined) {
            q = q.where(
              sql<boolean>`(e.ts, e.event_id) > (${after[0]}::timestamptz, ${after[1]}::uuid)`,
            );
          }
          return q
            .orderBy('e.ts')
            .orderBy('e.event_id')
            .limit(limit + 1)
            .execute();
        },
        { readOnly: true },
      );
      const page = rows.slice(0, limit);
      const events = page.map((row) => {
        const { seal_shard: shard, seal_seq: seq, ...event } = row;
        return {
          ...rowToEnvelope(event),
          seal: shard === null || seq === null ? null : { shard, seq: Number(seq) },
        };
      });
      const last = page.at(-1);
      request.log.info({ result_count: events.length }, 'audit_query');
      return {
        events,
        next_cursor:
          rows.length > limit && last !== undefined
            ? encodeCursor(last.ts.toISOString(), last.event_id)
            : null,
      };
    },
  );
}
