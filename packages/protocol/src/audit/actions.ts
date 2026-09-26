// The F-002 event catalogue (design §3.5) and the action rules the ingest paths apply
// (§3.4.4, [AR-3], SEC-F002-03). Later features append their actions.
import type { Outcome } from './envelope.js';

/** Every action F-002 emits. */
export const F002_ACTIONS = [
  'auth.sign_in',
  'auth.token.issued',
  'auth.refresh',
  'auth.token.reuse_detected',
  'auth.token_rejected',
  'auth.sign_out',
  'auth.session.revoked',
  'audit.query',
  'audit.ingest_rejected',
  'audit.modify_denied',
  'audit.schema_changed',
  'audit.client_seq_gap',
  'audit.client_session_unterminated',
  'secret.rotated',
  'secret.custody_violation',
  'directory.user.provisioned',
  'directory.user.updated',
  'directory.group_membership.changed',
  'directory.group_role.changed',
  'db.migration.applied',
] as const;
export type F002Action = (typeof F002_ACTIONS)[number];

/**
 * Namespaces only the control plane's own writer may use. A service may be allow-listed for the
 * exact reserved names in SERVICE_RESERVED_EXCEPTIONS and nothing else in these namespaces.
 */
export const RESERVED_NAMESPACES = [
  'auth.',
  'audit.',
  'secret.',
  'directory.',
  'db.',
  'policy.',
  'kill_switch.',
] as const;

export const SERVICE_RESERVED_EXCEPTIONS = ['auth.token_rejected', 'secret.rotated'] as const;

export function isReservedAction(action: string): boolean {
  return RESERVED_NAMESPACES.some((namespace) => action.startsWith(namespace));
}

/** Whether a service's configured `audit_actions` entry is allowed (config validation, TC-37). */
export function serviceMayBeAllowListed(action: string): boolean {
  return (
    !isReservedAction(action) || (SERVICE_RESERVED_EXCEPTIONS as readonly string[]).includes(action)
  );
}

/**
 * [AR-3] `failure` = an authentication or protocol attempt failed for a caller- or IdP-side
 * reason, and is valid on `auth.*` only. `denied` is a policy refusal; `error` a dependency or
 * internal fault.
 */
export function outcomeAllowed(action: string, outcome: Outcome): boolean {
  return outcome !== 'failure' || action.startsWith('auth.');
}
