// @ralysa/protocol/audit: audit envelope, event catalogue and canonical hashing (F-002 design §3.5,
// §4.6).
export {
  F002_ACTIONS,
  type F002Action,
  RESERVED_NAMESPACES,
  SERVICE_RESERVED_EXCEPTIONS,
  isReservedAction,
  outcomeAllowed,
  serviceMayBeAllowListed,
} from './actions.js';
export {
  AUDIT_BODY_MAX_BYTES,
  CLIENT_ACTION_ALLOWLIST,
  CLIENT_EVENT_MAX_BYTES,
  type ClientAction,
} from './client-allowlist.js';
export {
  ActionName,
  Actor,
  AuditEvent,
  AuditEventInput,
  IJson,
  Outcome,
  Source,
} from './envelope.js';
export {
  GENESIS_PREV_HASH,
  IJSON_MAX_DEPTH,
  IJsonError,
  type IJsonViolation,
  canonicalEnvelope,
  canonicalSize,
  chainHash,
  eventHash,
  eventHashHex,
  iJsonViolations,
  isIJson,
  jcs,
} from './jcs.js';
export { RESERVED_DETAIL_KEYS, type ReservedDetailKey, findReservedKeys } from './reserved.js';
export { AUDIT_SCHEMA_VERSION } from './version.js';
