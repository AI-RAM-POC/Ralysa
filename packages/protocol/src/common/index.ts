// @ralysa/protocol/common: primitives shared by every contract family (F-002 design §3.5, [AR-18]).
export { ERROR_CODES, ErrorCode, PROBLEM_CONTENT_TYPE, Problem, problemType } from './errors.js';
export { Region, Sha256Hex, SpanId, TraceId, UuidV7, uuidv7 } from './ids.js';
export {
  type TraceParent,
  formatTraceparent,
  newSpanId,
  newTraceId,
  parseTraceparent,
} from './trace.js';
export { fromHex, sha256, toHex } from '../platform.js';
