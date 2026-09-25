// The only actions the client-attested path accepts (F-002 design §3.4.5, AC-16). Everything else
// on `POST /v1/audit/client-events` is refused with 422.
export const CLIENT_ACTION_ALLOWLIST = [
  'tool.call.requested',
  'tool.call.completed',
  'tool.call.denied',
  'session.started',
  'session.ended',
  'hook.failed',
  'approval.presented',
] as const;
export type ClientAction = (typeof CLIENT_ACTION_ALLOWLIST)[number];

/** Client events above this canonical (JCS) size are refused with 413 [SEC-F002-15]. */
export const CLIENT_EVENT_MAX_BYTES = 4096;
/** Request bodies on both audit ingest paths are limited to 256 KB. */
export const AUDIT_BODY_MAX_BYTES = 256 * 1024;
