// Canonical form and hashing of audit events (F-002 design §4.6, [AR-5], [AR-7]; ADR-0021 as
// clarified 2026-09-25). One implementation, shared by the sealer and every verifier:
//
//   canonical(event) = RFC 8785 JCS over the stored envelope, with null or absent envelope fields
//                      omitted (so adding a nullable column later leaves old hashes unchanged)
//   event_hash       = SHA-256(canonical(event))
//   hash             = SHA-256(prev_hash ‖ event_hash), prev_hash of the first seal = 32 zero bytes
//
// `details` is I-JSON (RFC 7493) and is hashed as stored: its nulls are data, not omitted.
import canonicalize from 'canonicalize';
import { sha256, toHex, utf8 } from '../platform.js';

export const IJSON_MAX_DEPTH = 64;

export interface IJsonViolation {
  path: string;
  reason: string;
}

export class IJsonError extends Error {
  readonly violations: IJsonViolation[];
  constructor(violations: IJsonViolation[]) {
    super(
      `not I-JSON: ${violations
        .slice(0, 5)
        .map((v) => `${v.path} ${v.reason}`)
        .join('; ')}`,
    );
    this.violations = violations;
  }
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Why `value` is not I-JSON (RFC 7493), or [] when it is:
 * - numbers must be finite, and an integral number must be a safe integer (|n| ≤ 2^53 − 1),
 *   because a larger integer can't round-trip exactly and its hash would cover a different value;
 * - strings and member names must be valid Unicode (no lone surrogates);
 * - only null, booleans, numbers, strings, arrays and plain objects; no `undefined`;
 * - nesting deeper than IJSON_MAX_DEPTH is refused.
 */
export function iJsonViolations(value: unknown, path = '$', depth = 0): IJsonViolation[] {
  if (depth > IJSON_MAX_DEPTH)
    return [{ path, reason: `nests deeper than ${String(IJSON_MAX_DEPTH)}` }];
  if (value === null || typeof value === 'boolean') return [];
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return [{ path, reason: 'is not a finite number' }];
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return [{ path, reason: 'is an integer outside ±(2^53 − 1)' }];
    }
    return [];
  }
  if (typeof value === 'string') {
    return hasLoneSurrogate(value) ? [{ path, reason: 'has a lone surrogate' }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      iJsonViolations(item, `${path}[${String(index)}]`, depth + 1),
    );
  }
  if (typeof value === 'object' && isPlainObject(value)) {
    const out: IJsonViolation[] = [];
    for (const [key, child] of Object.entries(value)) {
      const here = `${path}.${key}`;
      if (hasLoneSurrogate(key))
        out.push({ path: here, reason: 'member name has a lone surrogate' });
      out.push(...iJsonViolations(child, here, depth + 1));
    }
    return out;
  }
  return [{ path, reason: `is not a JSON value (${typeof value})` }];
}

export function isIJson(value: unknown): boolean {
  return iJsonViolations(value).length === 0;
}

/** RFC 8785 canonical JSON of an I-JSON value; throws IJsonError otherwise. */
export function jcs(value: unknown): string {
  const violations = iJsonViolations(value);
  if (violations.length > 0) throw new IJsonError(violations);
  const text = canonicalize(value);
  if (text === undefined) throw new IJsonError([{ path: '$', reason: 'has no JSON form' }]);
  return text;
}

/** Envelope members whose own null members are omitted too (flat objects of envelope columns). */
const STRUCTURED_MEMBERS = new Set(['actor', 'act', 'resource']);

/**
 * The omit-null canonical envelope [AR-7]: drops every null or absent top-level member and every
 * null member of `actor`, `act` and `resource`. `details` is kept exactly as stored.
 */
export function canonicalEnvelope(
  event: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (value === null || value === undefined) continue;
    if (STRUCTURED_MEMBERS.has(key) && typeof value === 'object' && !Array.isArray(value)) {
      const inner: Record<string, unknown> = {};
      for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (innerValue !== null && innerValue !== undefined) inner[innerKey] = innerValue;
      }
      out[key] = inner;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** The size of an event's canonical form in UTF-8 bytes (the 4 KB client-event limit). */
export function canonicalSize(event: Readonly<Record<string, unknown>>): number {
  return utf8(jcs(canonicalEnvelope(event))).length;
}

/** 32 zero bytes: the `prev_hash` of the first seal in every `(org_id, shard)` chain. */
export const GENESIS_PREV_HASH: Uint8Array = new Uint8Array(32);

/** SHA-256 of the omit-null canonical form. Build `event` from the stored row, never the request. */
export async function eventHash(event: Readonly<Record<string, unknown>>): Promise<Uint8Array> {
  return sha256(utf8(jcs(canonicalEnvelope(event))));
}

/** SHA-256(prev_hash ‖ event_hash). */
export async function chainHash(
  prevHash: Uint8Array,
  eventHashValue: Uint8Array,
): Promise<Uint8Array> {
  if (prevHash.length !== 32 || eventHashValue.length !== 32) {
    throw new Error('chainHash expects two 32-byte SHA-256 values');
  }
  const joined = new Uint8Array(64);
  joined.set(prevHash, 0);
  joined.set(eventHashValue, 32);
  return sha256(joined);
}

export async function eventHashHex(event: Readonly<Record<string, unknown>>): Promise<string> {
  return toHex(await eventHash(event));
}
