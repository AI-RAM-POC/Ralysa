// Shared identifier primitives (F-002 design §3.5, [AR-18]).
import { z } from 'zod';
import { toHex, webCrypto } from '../platform.js';

/** W3C Trace Context trace-id: 32 lowercase hex characters. */
export const TraceId = z.string().regex(/^[0-9a-f]{32}$/);
/** W3C Trace Context parent-id (span): 16 lowercase hex characters. */
export const SpanId = z.string().regex(/^[0-9a-f]{16}$/);
/** SHA-256 digest as 64 lowercase hex characters. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
/** Deployment or processing region, for example `qa-doha-1` (data residency, SR-04). */
export const Region = z.string().regex(/^[a-z0-9-]{2,40}$/);

export type TraceId = z.infer<typeof TraceId>;
export type SpanId = z.infer<typeof SpanId>;
export type Sha256Hex = z.infer<typeof Sha256Hex>;
export type Region = z.infer<typeof Region>;

/**
 * A UUIDv7 (RFC 9562 §5.7): 48-bit Unix milliseconds, version 7, 74 random bits, variant 10.
 * Time-ordered, so ids sort roughly by creation (data-model §1 principle 5). Isomorphic
 * (WebCrypto randomness); no dependency.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > 0xffff_ffff_ffff) {
    throw new RangeError('uuidv7: timestamp out of range');
  }
  const bytes = webCrypto().getRandomValues(new Uint8Array(16));
  let ms = nowMs;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
