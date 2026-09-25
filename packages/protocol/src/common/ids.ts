// Shared identifier primitives (F-002 design §3.5, [AR-18]).
import { z } from 'zod';

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
