// The per-service audit action allow-list on POST /v1/audit/events (F-002 design §3.4.4, §3.8;
// SEC-F002-03). Each registered service may write only the exact actions in its
// `services[].audit_actions`. The namespaces auth., audit., secret., directory., db., policy. and
// kill_switch. belong to the control plane's own writer; a service may be allow-listed only for
// the exact reserved names auth.token_rejected and secret.rotated. Config validation refuses any
// other reserved entry at start (TC-F-002-37); the route checks the reserved rule again, so a
// config that somehow bypassed validation still can't open a reserved namespace.
//
// `source` is derived from the service name, never from the body (§3.4.4): the audit store's
// `source` column is a closed set, so a service whose name has no source can't write audit.
import { type Source, serviceMayBeAllowListed } from '@ralysa/protocol/audit';
import type { ServiceClient } from '../auth/clients.js';

/** Service names that write audit under their own `source` (§3.5 `Source`). */
const SERVICE_SOURCES: Readonly<Record<string, Source>> = {
  'model-gateway': 'model-gateway',
  'mcp-gateway': 'mcp-gateway',
  'workspace-runtime': 'workspace-runtime',
  // The server-side Agent Host (F-003); the local host writes through the client path. One
  // name only, so two registered services can never share a source (review of #33, R33-6).
  'agent-host': 'agent-host-server',
};

/** The audit `source` of a registered service, or undefined when it has none. */
export function sourceForService(name: string): Source | undefined {
  return Object.hasOwn(SERVICE_SOURCES, name) ? SERVICE_SOURCES[name] : undefined;
}

/** Whether `service` may write `action`: allow-listed, and not in a reserved namespace. */
export function serviceMayWrite(service: Pick<ServiceClient, 'auditActions'>, action: string) {
  return service.auditActions.includes(action) && serviceMayBeAllowListed(action);
}

/** The distinct actions of a batch the service may not write, in first-seen order. */
export function disallowedActions(
  service: Pick<ServiceClient, 'auditActions'>,
  actions: readonly string[],
): string[] {
  return [...new Set(actions)].filter((action) => !serviceMayWrite(service, action));
}
