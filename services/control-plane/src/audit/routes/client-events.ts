// POST /v1/audit/client-events: the client-attested path (F-002 design §3.4.5, §5.6; AC-16;
// [AR-14]; SEC-F002-14, -15, -30; TM-11, TM-45 b, TM-48). The local Agent Host (F-003) reports
// local-tool activity with the signed-in user's access token (`aud=control-plane`).
//
// The server:
// - OVERWRITES the actor (the token's user), org, `source = agent-host-local`,
//   `attestation = client`, `surface` (the token's) and `ts`; nothing in the body can claim them;
// - accepts only the client allow-list (else 422), 1–50 events, at most 4 KB per event in
//   canonical form (else 413) and 256 KB per body (413, the app's body limit);
// - stores the client's data under `details.client.*` and its own facts under `details.server.*`;
//   a client payload with a reserved key is 422 [SEC-F002-15]. Display strings from this path
//   lose bidi and control characters [SEC-F002-30]; they stay untrusted (TM-11);
// - issues sessions: a batch without `session_id` must start with `session.started`, and gets a
//   new UUIDv7 session bound to the token's `sid`; an unknown, foreign, other-`sid` or ended
//   session is 409; at most 20 open sessions per `sid` (429) [SEC-F002-14];
// - tracks `client_seq` per session (client-sessions.ts): gaps, late events and `final_seq`;
// - answers every `tool.call.requested` with an IntentAck. While an active kill-switch covers the
//   tenant, the user's department, or the host-declared pack or agent, the intent is refused: it
//   is stored as `tool.call.denied` (`reason_code = kill_switch`) and the answer is 423 with
//   `halted = true` (TM-48);
// - fails closed: if the insert fails or exceeds 250 ms, nothing is stored or advanced and the
//   answer is 503 with `ack = false` for every intent (G-5, G-6);
// - limits each user to 600 events a minute (per instance, like the other in-memory limits).
//
// These events never count toward the model and remote-tool audit NFR (§3.4.5).
import {
  CLIENT_EVENT_MAX_BYTES,
  canonicalSize,
  findReservedKeys,
  iJsonViolations,
  outcomeAllowed,
} from '@ralysa/protocol/audit';
import { uuidv7 } from '@ralysa/protocol/common';
import {
  CLIENT_EVENTS_PER_USER_PER_MINUTE,
  CLIENT_SESSIONS_MAX_OPEN,
  type ClientAuditEventInput,
  ClientEventsRequest,
  type IntentAck,
} from '@ralysa/protocol/control-plane';
import type { VerifiedPrincipal } from '@ralysa/auth';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { RtsDeps } from '../../auth/deps.js';
import { isStrippedCodePoint, sanitizeDisplayText } from '../../auth/display-text.js';
import { authenticate } from '../../auth/route-auth.js';
import { withOrg } from '../../db/kysely.js';
import {
  type ActiveKillSwitch,
  coveringKillSwitch,
  readActiveKillSwitches,
  readGovernanceEpoch,
} from '../../governance/kill-switch.js';
import { ROUTES } from '../../http/contracts.js';
import { HttpProblem, problemBody } from '../../http/errors.js';
import { createRateLimiter } from '../../http/rate-limits.js';
import {
  type CursorState,
  type SeqRange,
  type SessionOwner,
  applySeq,
  clientSeqGapEvent,
  formatMultirange,
  parseMultirange,
  tailGap,
} from '../client-sessions.js';
import type { StoredEventInput } from '../columns.js';
import { AuditUnavailableError, InvalidAuditEventError } from '../writer.js';

type ResultStatus = 'stored' | 'duplicate';

interface Outcome {
  sessionId: string;
  results: { event_id: string; status: ResultStatus; ack?: IntentAck }[];
  halted: boolean;
}

/** A batch the route refuses as a whole (nothing stored, nothing advanced). */
class Refusal extends Error {
  constructor(readonly code: 'conflict' | 'rate_limited' | 'unprocessable') {
    super(code);
  }
}

/** What the store already holds for an event id of the batch (read with the reader role). */
export interface StoredFact {
  action: string;
  sessionId: string | null;
  clientSeq: number | null;
}

/** Nothing could be stored: every intent is answered ack=false. */
class Unavailable extends Error {
  constructor(readonly acks: IntentAck[]) {
    super('audit unavailable');
  }
}

const INTENT = 'tool.call.requested';

/** Strips bidi and control characters from every string in client data (keys unchanged). */
function stripDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return Array.from(value)
      .filter((ch) => !isStrippedCodePoint(ch.codePointAt(0) ?? 0))
      .join('');
  }
  if (Array.isArray(value)) return value.map(stripDeep);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripDeep(v)]));
  }
  return value;
}

const text = (value: string | null, max: number): string | null =>
  value === null ? null : (sanitizeDisplayText(value, max) ?? null);

const clientString = (client: Record<string, unknown>, key: string): string | undefined => {
  const value = client[key];
  return typeof value === 'string' && value.length <= 200 ? value : undefined;
};

/** Refusals that need no database: 422 and 413 (§3.4.5, SEC-F002-15). */
function checkEvents(events: readonly ClientAuditEventInput[]): void {
  for (const event of events) {
    if (event.final_seq !== undefined && event.action !== 'session.ended') {
      throw new HttpProblem('unprocessable');
    }
    if (findReservedKeys(event.client).length > 0) throw new HttpProblem('unprocessable');
    if (iJsonViolations(event.client).length > 0) throw new HttpProblem('unprocessable');
    // `failure` is for auth.* only [AR-3]: the writer would refuse the event, so refuse the
    // batch here with 422 instead of failing every retry (review of #33, R33-1).
    if (!outcomeAllowed(event.action, event.outcome ?? 'success')) {
      throw new HttpProblem('unprocessable');
    }
    if (canonicalSize(event) > CLIENT_EVENT_MAX_BYTES) throw new HttpProblem('payload_too_large');
  }
}

export function registerClientEvents(app: FastifyInstance, deps: RtsDeps): void {
  const limiter = createRateLimiter({
    perIpPerMinute: CLIENT_EVENTS_PER_USER_PER_MINUTE,
    globalPerMinute: Number.MAX_SAFE_INTEGER,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  const ingest = async (
    principal: VerifiedPrincipal,
    request: FastifyRequest,
    sessionIdIn: string | undefined,
    events: readonly ClientAuditEventInput[],
    existing: ReadonlyMap<string, StoredFact>,
  ): Promise<Outcome> =>
    withOrg(deps.db, principal.orgId, async (trx) => {
      // One batch at a time per auth session: the open-session count and each cursor are
      // read and advanced under this lock.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`client-audit|${principal.sessionId}`}, 0))`.execute(
        trx,
      );
      let sessionId = sessionIdIn;
      // A retried opening batch whose session.started is already stored (its answer was lost):
      // continue that session if it is this user's under this sid (review of #33, R33-4).
      const opened = sessionId === undefined ? existing.get(events[0]?.event_id ?? '') : undefined;
      if (opened?.action === 'session.started' && opened.sessionId !== null) {
        const mine = await trx
          .selectFrom('cp.client_audit_cursor')
          .select('session_id')
          .where('user_id', '=', principal.userId)
          .where('session_id', '=', opened.sessionId)
          .where('sid', '=', principal.sessionId)
          .executeTakeFirst();
        if (mine !== undefined) sessionId = mine.session_id;
      }
      let state: CursorState;
      let endedBefore = false;
      if (sessionId === undefined) {
        const open = await trx
          .selectFrom('cp.client_audit_cursor')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('sid', '=', principal.sessionId)
          .where('ended_at', 'is', null)
          .executeTakeFirst();
        if (Number(open?.n ?? 0) >= CLIENT_SESSIONS_MAX_OPEN) throw new Refusal('rate_limited');
        sessionId = uuidv7();
        await trx
          .insertInto('cp.client_audit_cursor')
          .values({
            org_id: principal.orgId,
            user_id: principal.userId,
            sid: principal.sessionId,
            session_id: sessionId,
          })
          .execute();
        state = { lastSeq: 0, openGaps: [] };
      } else {
        const cursor = await trx
          .selectFrom('cp.client_audit_cursor')
          .select(['sid', 'last_seq', 'open_gaps', 'ended_at'])
          .where('user_id', '=', principal.userId)
          .where('session_id', '=', sessionId)
          .forUpdate()
          .executeTakeFirst();
        // Unknown, another user's or another sign-in's: the same answer. An ended session
        // takes nothing new; a retry made only of stored events is still answered.
        const onlyRetries = events.every((e) => existing.has(e.event_id));
        if (cursor?.sid !== principal.sessionId || (cursor.ended_at !== null && !onlyRetries)) {
          throw new Refusal('conflict');
        }
        endedBefore = cursor.ended_at !== null;
        state = { lastSeq: Number(cursor.last_seq), openGaps: parseMultirange(cursor.open_gaps) };
      }
      const initial = { lastSeq: state.lastSeq, gaps: formatMultirange(state.openGaps) };

      const user = await trx
        .selectFrom('cp.app_user')
        .select('department_id')
        .where('id', '=', principal.userId)
        .executeTakeFirst();
      const switches: ActiveKillSwitch[] = await readActiveKillSwitches(trx);
      const epoch = await readGovernanceEpoch(trx);
      const owner: SessionOwner = {
        orgId: principal.orgId,
        userId: principal.userId,
        idpSubject: principal.idpSubject,
        sessionId,
      };

      const toStore: StoredEventInput[] = [];
      const results: Outcome['results'] = [];
      const seen = new Set<string>();
      let halted = false;
      let ended: { finalSeq: number | null; gaps: SeqRange[] } | undefined;
      for (const event of events) {
        const ackFor = (covering: ActiveKillSwitch | undefined): IntentAck => ({
          event_id: event.event_id,
          ack: covering === undefined,
          governance: {
            epoch,
            halted: covering !== undefined,
            reason_category: covering === undefined ? null : 'kill_switch',
          },
        });
        const covering =
          event.action === INTENT
            ? coveringKillSwitch(switches, {
                orgId: principal.orgId,
                departmentId: user?.department_id ?? null,
                ...optional('packId', clientString(event.client, 'pack_id')),
                ...optional('agentId', clientString(event.client, 'agent_id')),
              })
            : undefined;
        const stored = existing.get(event.event_id);
        if (stored !== undefined || seen.has(event.event_id)) {
          // A retry of an event already stored. An intent stored as refused stays refused, even
          // if the switch was lifted since: no tool.call.requested exists for it (R33-2). Other
          // intents are answered from the current state.
          const refused = stored?.action === 'tool.call.denied' && event.action === INTENT;
          if (covering !== undefined || refused) halted = true;
          results.push({
            event_id: event.event_id,
            status: 'duplicate',
            ...(event.action === INTENT
              ? {
                  ack: refused
                    ? {
                        event_id: event.event_id,
                        ack: false,
                        governance: { epoch, halted: true, reason_category: 'kill_switch' },
                      }
                    : ackFor(covering),
                }
              : {}),
          });
          // A stored event of THIS session whose write committed after the batch was answered
          // 503 (writer.ts: the 250 ms bound): its seq still advances the cursor, so the next
          // event isn't a false gap (R33-3). A seq the cursor already covers changes nothing.
          if (!endedBefore && stored?.sessionId === sessionId && stored.clientSeq !== null) {
            const applied = applySeq(state, stored.clientSeq);
            if (applied.verdict.kind !== 'conflict') state = applied.state;
            if (event.action === 'session.ended' && ended === undefined) {
              const tail =
                event.final_seq === undefined ? undefined : tailGap(state, event.final_seq);
              ended = {
                finalSeq: event.final_seq ?? null,
                gaps: [...state.openGaps, ...(tail === undefined ? [] : [tail])],
              };
            }
          }
          continue;
        }
        seen.add(event.event_id);
        if (ended !== undefined) throw new Refusal('conflict'); // after session.ended
        const applied = applySeq(state, event.client_seq);
        if (applied.verdict.kind === 'conflict') throw new Refusal('conflict');
        state = applied.state;

        const server: Record<string, unknown> = {};
        if (applied.verdict.kind === 'gap') server.seq_gap = [...applied.verdict.gap];
        if (applied.verdict.kind === 'late') server.late = true;
        if (event.final_seq !== undefined) server.final_seq = event.final_seq;
        if (covering !== undefined) {
          halted = true;
          server.kill_switch = { scope: covering.scope, scope_id: covering.scopeId };
          server.requested_action = event.action;
        } else if (event.outcome === null) {
          server.outcome_defaulted = true;
        }
        const resourceId = event.resource === null ? null : text(event.resource.id, 128);
        toStore.push({
          event_id: event.event_id,
          action: covering === undefined ? event.action : 'tool.call.denied',
          actor: {
            type: 'user',
            user_id: principal.userId,
            idp_subject: principal.idpSubject,
            service: null,
          },
          surface: principal.surface,
          resource: event.resource === null ? null : { type: 'local_tool', id: resourceId ?? '' },
          operation: text(event.operation, 32),
          // A null outcome (an intent, a session event) records that the event itself happened.
          outcome: covering === undefined ? (event.outcome ?? 'success') : 'denied',
          reason_code: covering === undefined ? text(event.reason_code, 64) : 'kill_switch',
          session_id: sessionId,
          turn_id: text(event.turn_id, 64),
          tool_call_id: text(event.tool_call_id, 64),
          trace_id: event.trace_id,
          span_id: event.span_id,
          payload_hash: event.payload_hash,
          details: {
            client: stripDeep(event.client) as StoredEventInput['details'],
            ...(Object.keys(server).length === 0 ? {} : { server }),
          } as StoredEventInput['details'],
          source: 'agent-host-local',
          attestation: 'client',
          client_seq: event.client_seq,
        });
        results.push({
          event_id: event.event_id,
          status: 'stored',
          ...(event.action === INTENT ? { ack: ackFor(covering) } : {}),
        });
        if (event.action === 'session.ended') {
          const tail = event.final_seq === undefined ? undefined : tailGap(state, event.final_seq);
          ended = {
            finalSeq: event.final_seq ?? null,
            gaps: [...state.openGaps, ...(tail === undefined ? [] : [tail])],
          };
        }
      }
      // Every range still open at session.ended is final now (and the missing tail).
      for (const gap of ended?.gaps ?? []) {
        toStore.push(clientSeqGapEvent(owner, gap, 'session_ended', request.traceId));
      }

      try {
        const written = await deps.writer.write(principal.orgId, toStore);
        const status = new Map(written.map((r) => [r.event_id, r.status]));
        for (const result of results) {
          if (result.status === 'stored') result.status = status.get(result.event_id) ?? 'stored';
        }
      } catch (error) {
        if (error instanceof InvalidAuditEventError) throw new Refusal('unprocessable');
        if (!(error instanceof AuditUnavailableError)) throw error;
        throw new Unavailable(
          events
            .filter((e) => e.action === INTENT)
            .map((e) => ({
              event_id: e.event_id,
              ack: false,
              governance: { epoch, halted: false, reason_category: 'audit_unavailable' },
            })),
        );
      }
      const changed =
        toStore.length > 0 ||
        state.lastSeq !== initial.lastSeq ||
        formatMultirange(state.openGaps) !== initial.gaps;
      if (!changed || endedBefore) return { sessionId, results, halted };
      await trx
        .updateTable('cp.client_audit_cursor')
        .set({
          last_seq: state.lastSeq,
          open_gaps: formatMultirange(ended === undefined ? state.openGaps : []),
          ...(ended === undefined
            ? {}
            : {
                final_seq: ended.finalSeq === null ? null : String(ended.finalSeq),
                ended_at: sql`now()`,
              }),
          updated_at: sql`now()`,
        })
        .where('user_id', '=', principal.userId)
        .where('session_id', '=', sessionId)
        .execute();
      return { sessionId, results, halted };
    });

  app.post(
    ROUTES.clientEvents.url,
    {
      schema: {
        response: {
          201: ROUTES.clientEvents.responses[201].schema,
          423: ROUTES.clientEvents.responses[423].schema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = await authenticate(deps, request, 'user');
      const parsed = ClientEventsRequest.safeParse(request.body);
      if (!parsed.success) throw new HttpProblem('unprocessable');
      const { session_id: sessionId, events } = parsed.data;
      checkEvents(events);
      const opening = sessionId === undefined;
      if (opening ? events[0]?.action !== 'session.started' : false) {
        throw new HttpProblem('conflict');
      }
      if (events.some((e, i) => e.action === 'session.started' && (!opening || i > 0))) {
        throw new HttpProblem('conflict');
      }
      const retry = limiter.take(principal.userId, events.length);
      if (retry > 0) {
        throw new HttpProblem('rate_limited', undefined, {
          headers: { 'retry-after': String(retry) },
        });
      }
      const reader = deps.auditReader;
      if (reader === undefined) throw new HttpProblem('temporarily_unavailable');

      let outcome: Outcome;
      try {
        // Duplicates are detected by event_id (§3.4.5); the writer role has no SELECT.
        const ids = events.map((e) => e.event_id);
        const found = await withOrg(
          reader,
          principal.orgId,
          async (trx) =>
            trx
              .selectFrom('audit.audit_event')
              .select(['event_id', 'action', 'session_id', 'client_seq', 'actor_user_id'])
              .where('event_id', 'in', ids)
              .execute(),
          { readOnly: true },
        );
        const existing = new Map<string, StoredFact>(
          found.map((row) => [
            row.event_id,
            {
              action: row.action,
              // Session facts only for the caller's own events.
              sessionId: row.actor_user_id === principal.userId ? row.session_id : null,
              clientSeq:
                row.actor_user_id === principal.userId && row.client_seq !== null
                  ? Number(row.client_seq)
                  : null,
            },
          ]),
        );
        outcome = await ingest(principal, request, sessionId, events, existing);
      } catch (error) {
        if (error instanceof Refusal) throw new HttpProblem(error.code);
        if (error instanceof Unavailable) {
          return reply
            .status(503)
            .type('application/problem+json')
            .send({ ...problemBody('audit_unavailable', request), acks: error.acks });
        }
        throw error;
      }
      return reply
        .status(outcome.halted ? 423 : 201)
        .send({ session_id: outcome.sessionId, results: outcome.results });
    },
  );
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
