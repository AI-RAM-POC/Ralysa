// GET /v1/internal/governance (F-002 design §3.2.6, §3.4.3; SEC-F002-18; G-1). Service tokens
// only. Served from the database with at most 1 s of caching: `issued_at` is the database clock,
// `epoch` is cp.governance_epoch_seq (every revocation advances it, so it never decreases), and
// without `since` the feed covers the maximum configurable access TTL + 5 min.
//
// The cursor LAGS issued_at by CURSOR_OVERLAP_S. A revocation stamps revoked_at with the clock
// inside its transaction and becomes visible only at commit, so a poll between the two would
// otherwise set a cursor past a revocation it never saw, and every later poll would skip it.
// Repeating the last minute costs a few duplicate rows, which PEPs de-duplicate.
import { GOVERNANCE_FEED, type GovernanceState } from '@ralysa/protocol/control-plane';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { withOrg } from '../db/kysely.js';
import type { Database } from '../db/types.js';
import { ROUTES } from '../http/contracts.js';
import { HttpProblem } from '../http/errors.js';
import type { RtsDeps } from './deps.js';
import { authenticate } from './route-auth.js';

export const CURSOR_OVERLAP_S = 60;

export async function readGovernanceState(
  db: Kysely<Database>,
  orgId: string,
  since: Date | undefined,
): Promise<GovernanceState> {
  return withOrg(
    db,
    orgId,
    async (trx) => {
      const { rows: head } = await sql<{ now: Date; epoch: string; called: boolean }>`
        select clock_timestamp() as now, last_value as epoch, is_called as called
          from cp.governance_epoch_seq`.execute(trx);
      const now = head[0]?.now ?? new Date();
      const windowStart = new Date(now.getTime() - GOVERNANCE_FEED.defaultWindowSeconds * 1000);
      const from = since === undefined || since < windowStart ? windowStart : since;
      const sessions = await trx
        .selectFrom('cp.auth_session')
        .select(['id', 'revoked_at'])
        .where('revoked_at', 'is not', null)
        .where('revoked_at', '>', from)
        .orderBy('revoked_at')
        .execute();
      const users = await trx
        .selectFrom('cp.app_user')
        .select(['id', 'revoked_before'])
        .where('revoked_before', 'is not', null)
        .where('revoked_before', '>', from)
        .execute();
      const switches = await trx
        .selectFrom('cp.kill_switch')
        .select(['scope', 'scope_id', 'active'])
        .execute();
      return {
        epoch: head[0]?.called === true ? Number(head[0].epoch) : 0,
        issued_at: now.toISOString(),
        cursor: new Date(now.getTime() - CURSOR_OVERLAP_S * 1000).toISOString(),
        revoked_sessions: sessions.map((s) => ({
          sid: s.id,
          revoked_at: (s.revoked_at as Date).toISOString(),
        })),
        users_revoked_before: users.map((u) => ({
          user_id: u.id,
          revoked_before: (u.revoked_before as Date).toISOString(),
        })),
        kill_switches: switches.map((k) => ({
          scope: k.scope,
          scope_id: k.scope_id,
          active: k.active,
        })),
      };
    },
    { readOnly: true },
  );
}

export function registerGovernanceFeed(app: FastifyInstance, deps: RtsDeps): void {
  const cache = new Map<string, { at: number; state: GovernanceState }>();
  const now = deps.now ?? (() => Date.now());
  app.get(
    ROUTES.governance.url,
    { schema: { response: { 200: ROUTES.governance.responses[200].schema } } },
    async (request) => {
      await authenticate(deps, request, 'service');
      const raw = (request.query as { since?: unknown }).since;
      let since: Date | undefined;
      if (raw !== undefined) {
        if (typeof raw !== 'string' || raw.length > 64 || Number.isNaN(Date.parse(raw))) {
          throw new HttpProblem('invalid_request');
        }
        since = new Date(raw);
      }
      const key = since?.toISOString() ?? '';
      const hit = cache.get(key);
      if (hit !== undefined && now() - hit.at <= 1_000) return hit.state;
      const state = await readGovernanceState(deps.db, deps.config.org.id, since);
      if (cache.size > 1_000) cache.clear();
      cache.set(key, { at: now(), state });
      return state;
    },
  );
}
