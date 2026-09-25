// W3C Trace Context `traceparent` (https://www.w3.org/TR/trace-context/): every `/v1` response
// carries it back, and every audit event has a `trace_id` from it or generated at the edge
// (F-002 design §3.1, §6.4).
import { randomHex } from '../platform.js';

export interface TraceParent {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

/**
 * Parses a `traceparent` header. Returns undefined for anything invalid, so the caller starts a
 * new trace: version `ff`, all-zero ids, upper-case hex, or extra fields on version `00`.
 */
export function parseTraceparent(header: string | undefined): TraceParent | undefined {
  if (header === undefined) return undefined;
  const match = TRACEPARENT.exec(header.trim());
  if (match === null) return undefined;
  const [, version, traceId, spanId, flags] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version === 'ff') return undefined;
  if (version === '00' && header.trim().length !== 55) return undefined;
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(parent: TraceParent): string {
  return `00-${parent.traceId}-${parent.spanId}-${parent.sampled ? '01' : '00'}`;
}

export function newTraceId(): string {
  let id = randomHex(16);
  while (id === ZERO_TRACE) id = randomHex(16);
  return id;
}

export function newSpanId(): string {
  let id = randomHex(8);
  while (id === ZERO_SPAN) id = randomHex(8);
  return id;
}
