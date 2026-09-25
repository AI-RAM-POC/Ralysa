// `client_seq` bookkeeping for the client-attested path (F-002 design §3.4.5, §4.4; [AR-14],
// SEC-F002-14). Pure functions over a session's cursor: the highest `client_seq` seen and the
// gaps still open. The route and the sweep keep the cursor in cp.client_audit_cursor
// (`open_gaps` is an int8multirange).
//
//   seq = last + 1              → the next event
//   seq > last + 1              → stored with details.server.seq_gap = [last+1, seq-1]; the range
//                                  is recorded as an open (provisional) gap
//   seq ≤ last, inside a gap    → stored with details.server.late = true; closes that seq
//   seq ≤ last, anything else   → 409 (duplicates are detected by event_id before this)
//
// A gap is final at `session.ended` (with the missing tail up to `final_seq`), after 15 minutes
// without events, or when the unterminated-session sweep closes the cursor: one
// `audit.client_seq_gap` per range. Their event ids are derived from the session and the range,
// so the route, the sweep and a retry after a failed commit can't record one range twice.
import { createHash } from 'node:crypto';
import { newTraceId } from '@ralysa/protocol/common';
import type { StoredEventInput } from './columns.js';

/** An inclusive range of missing `client_seq` values. */
export type SeqRange = readonly [from: number, to: number];

export interface CursorState {
  lastSeq: number;
  openGaps: readonly SeqRange[];
}

export type SeqVerdict =
  { kind: 'next' } | { kind: 'gap'; gap: SeqRange } | { kind: 'late' } | { kind: 'conflict' };

/** Postgres int8multirange text (`{[3,5),[7,8)}`, canonical half-open) → inclusive ranges. */
export function parseMultirange(text: string): SeqRange[] {
  const ranges: SeqRange[] = [];
  for (const match of text.matchAll(/([[(])(\d+),(\d+)([\])])/g)) {
    const [, open = '[', lo = '0', hi = '0', close = ')'] = match;
    const from = Number(lo) + (open === '(' ? 1 : 0);
    const to = Number(hi) - (close === ')' ? 1 : 0);
    if (from <= to) ranges.push([from, to]);
  }
  return normalise(ranges);
}

/** Inclusive ranges → int8multirange text for an UPDATE (`{}` when empty). */
export function formatMultirange(ranges: readonly SeqRange[]): string {
  return `{${normalise(ranges)
    .map(([from, to]) => `[${String(from)},${String(to + 1)})`)
    .join(',')}}`;
}

function normalise(ranges: readonly SeqRange[]): SeqRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = out.at(-1);
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

function withoutSeq(ranges: readonly SeqRange[], seq: number): SeqRange[] {
  return ranges.flatMap(([from, to]): SeqRange[] => {
    if (seq < from || seq > to) return [[from, to]];
    const parts: SeqRange[] = [];
    if (from <= seq - 1) parts.push([from, seq - 1]);
    if (seq + 1 <= to) parts.push([seq + 1, to]);
    return parts;
  });
}

/** Applies one new event's `client_seq` to the cursor. */
export function applySeq(
  state: CursorState,
  seq: number,
): { state: CursorState; verdict: SeqVerdict } {
  if (seq === state.lastSeq + 1) {
    return { state: { ...state, lastSeq: seq }, verdict: { kind: 'next' } };
  }
  if (seq > state.lastSeq + 1) {
    const gap: SeqRange = [state.lastSeq + 1, seq - 1];
    return {
      state: { lastSeq: seq, openGaps: normalise([...state.openGaps, gap]) },
      verdict: { kind: 'gap', gap },
    };
  }
  if (state.openGaps.some(([from, to]) => seq >= from && seq <= to)) {
    return {
      state: { ...state, openGaps: withoutSeq(state.openGaps, seq) },
      verdict: { kind: 'late' },
    };
  }
  return { state, verdict: { kind: 'conflict' } };
}

/** The missing tail `(last, final_seq]` declared by `session.ended`, if any. */
export function tailGap(state: CursorState, finalSeq: number): SeqRange | undefined {
  return finalSeq > state.lastSeq ? [state.lastSeq + 1, finalSeq] : undefined;
}

/** A stable UUID (version 8) for a server event about a client session. */
export function sessionEventId(orgId: string, sessionId: string, kind: string): string {
  const h = createHash('sha256')
    .update(`client-session|${orgId}|${sessionId}|${kind}`)
    .digest('hex');
  const variant = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const gapEventId = (orgId: string, sessionId: string, [from, to]: SeqRange): string =>
  sessionEventId(orgId, sessionId, `gap|${String(from)}|${String(to)}`);

export interface SessionOwner {
  orgId: string;
  userId: string;
  idpSubject: string | null;
  sessionId: string;
}

const sessionActor = (owner: SessionOwner): StoredEventInput['actor'] => ({
  type: 'user',
  user_id: owner.userId,
  idp_subject: owner.idpSubject,
  service: null,
});

/** `audit.client_seq_gap` (§3.5, outcome error): one per final missing range. */
export function clientSeqGapEvent(
  owner: SessionOwner,
  gap: SeqRange,
  cause: 'session_ended' | 'idle' | 'unterminated',
  traceId: string = newTraceId(),
): StoredEventInput {
  return {
    event_id: gapEventId(owner.orgId, owner.sessionId, gap),
    action: 'audit.client_seq_gap',
    actor: sessionActor(owner),
    outcome: 'error',
    reason_code: 'client_seq_gap',
    session_id: owner.sessionId,
    trace_id: traceId,
    details: {
      session_id: owner.sessionId,
      missing_from: gap[0],
      missing_to: gap[1],
      cause,
    },
    source: 'control-plane',
    attestation: 'server',
  };
}

/** `audit.client_session_unterminated` (§3.5, outcome error), from the sweep. */
export function clientSessionUnterminatedEvent(
  owner: SessionOwner,
  lastSeq: number,
): StoredEventInput {
  return {
    event_id: sessionEventId(owner.orgId, owner.sessionId, 'unterminated'),
    action: 'audit.client_session_unterminated',
    actor: sessionActor(owner),
    outcome: 'error',
    reason_code: 'no_session_ended',
    session_id: owner.sessionId,
    trace_id: newTraceId(),
    details: { session_id: owner.sessionId, last_seq: lastSeq },
    source: 'control-plane',
    attestation: 'server',
  };
}
