// Microsoft Graph behind the IdpDirectory port (F-002 design §6.3; D-22, D-36; SEC-F002-08, -09).
//
// At every sign-in and every refresh, for the user's object id:
//   GET  /v1.0/users/{oid}?$select=accountEnabled,signInSessionsValidFromDateTime
//   POST /v1.0/users/{oid}/checkMemberGroups  { groupIds: [access, admin] }  (transitive)
// Graph is authoritative for the two configured groups, whatever the token's `groups` claim says.
// `404 Request_ResourceNotFound` means the user was deleted. Every call is bounded by
// `idp.graph_timeout_ms` (≤ 3 s); after 5 consecutive failures the circuit opens for 30 s and
// checks answer `unavailable` at once. Only `idp.graph_base_url` is ever called: nothing a token
// carries (`_claim_sources`) is dereferenced.
//
// Graph is called with an app-only token (client credentials at the pinned tenant's token
// endpoint, scope https://graph.microsoft.com/.default) using the RTS client secret read from
// OpenBao KV. The token is cached until 60 s before it expires. `invalid_client` re-reads the
// secret once (a rotation; the full watcher is F-002-T13). Responses are validated with zod:
// Graph's answers are external input.
import type { SecretStore } from '@ralysa/secrets';
import { z } from 'zod';
import type { ServeConfig } from '../../config/schema.js';
import type { Metrics } from '../../observability/metrics.js';
import { noopMetrics } from '../../observability/metrics.js';
import type { DirectoryCheck, IdpDirectory } from '../directory-port.js';

export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
export const CIRCUIT_FAILURES = 5;
export const CIRCUIT_OPEN_MS = 30_000;
export const GROUP_NAME_TIMEOUT_MS = 2_000;

const TokenResponse = z.looseObject({
  access_token: z.string().min(1).max(16_384),
  expires_in: z.coerce.number().int().min(1),
});
const UserState = z.looseObject({
  accountEnabled: z.boolean(),
  signInSessionsValidFromDateTime: z.iso.datetime({ offset: true }).nullable().optional(),
});
const MemberGroups = z.looseObject({ value: z.array(z.string().max(64)).max(20) });
const GroupName = z.looseObject({ displayName: z.string().max(256).nullable() });

class GraphFailure extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'GraphFailure';
  }
}

export interface GraphDirectoryOptions {
  config: Pick<ServeConfig, 'idp' | 'access'>;
  secrets: SecretStore;
  /** The pinned tenant's token endpoint (from discovery). */
  tokenEndpoint: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
  metrics?: Metrics;
}

export interface GraphDirectory extends IdpDirectory {
  /** Circuit state (tests, readiness diagnostics). */
  circuit(): { open: boolean; consecutiveFailures: number };
}

export function createGraphDirectory(options: GraphDirectoryOptions): GraphDirectory {
  const { idp, access } = options.config;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const metrics = options.metrics ?? noopMetrics;
  const base = `${idp.graph_base_url.replace(/\/+$/, '')}/v1.0`;
  const timeoutMs = idp.graph_timeout_ms;
  let failures = 0;
  let openUntil = 0;
  let appToken: { value: string; until: number } | undefined;
  let secret: Promise<string> | undefined;

  const readSecret = (): Promise<string> => {
    secret ??= options.secrets.get(idp.client_secret_path).then((s) => s.value);
    return secret.catch((error: unknown) => {
      secret = undefined;
      throw error;
    });
  };

  const requestAppToken = async (): Promise<Response> =>
    doFetch(await options.tokenEndpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: idp.rts_client_id,
        client_secret: await readSecret(),
        scope: GRAPH_SCOPE,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });

  const fetchToken = async (): Promise<string> => {
    let response = await requestAppToken();
    if (response.status === 401 || response.status === 400) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      if (body.error !== 'invalid_client')
        throw new GraphFailure(`token ${String(response.status)}`);
      secret = undefined; // rotated: read the current version once
      response = await requestAppToken();
    }
    if (!response.ok) throw new GraphFailure(`token ${String(response.status)}`);
    const parsed = TokenResponse.safeParse(await response.json());
    if (!parsed.success) throw new GraphFailure('token response malformed');
    appToken = {
      value: parsed.data.access_token,
      until: now() + Math.max(0, parsed.data.expires_in - 60) * 1000,
    };
    return appToken.value;
  };
  // Single flight: the two calls of a check start together and share one token request.
  let inflight: Promise<string> | undefined;
  const token = (): Promise<string> => {
    if (appToken !== undefined && now() < appToken.until) return Promise.resolve(appToken.value);
    inflight ??= fetchToken().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  const call = async (
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; timeout?: number },
  ): Promise<Response> =>
    doFetch(`${base}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${await token()}`,
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(init.timeout ?? timeoutMs),
    });

  const succeeded = () => {
    failures = 0;
  };
  const failed = (reason: string): DirectoryCheck => {
    failures += 1;
    metrics.increment('graph_failures_total');
    if (failures >= CIRCUIT_FAILURES) {
      openUntil = now() + CIRCUIT_OPEN_MS;
      failures = 0;
      metrics.increment('graph_circuit_opened_total');
    }
    return { kind: 'unavailable', reason };
  };

  return {
    async check({ idpSubject }) {
      if (now() < openUntil) return { kind: 'unavailable', reason: 'circuit_open' };
      const user = encodeURIComponent(idpSubject);
      try {
        const [state, groups] = await Promise.all([
          call(`/users/${user}?$select=accountEnabled,signInSessionsValidFromDateTime`, {
            method: 'GET',
          }),
          call(`/users/${user}/checkMemberGroups`, {
            method: 'POST',
            body: { groupIds: [access.access_group_id, access.admin_group_id] },
          }),
        ]);
        if (state.status === 404) {
          await groups.body?.cancel();
          succeeded();
          return { kind: 'deleted' };
        }
        if (!state.ok) throw new GraphFailure(`user ${String(state.status)}`);
        if (!groups.ok) {
          if (groups.status === 404) {
            succeeded();
            return { kind: 'deleted' };
          }
          throw new GraphFailure(`checkMemberGroups ${String(groups.status)}`);
        }
        const parsedState = UserState.safeParse(await state.json());
        const parsedGroups = MemberGroups.safeParse(await groups.json());
        if (!parsedState.success || !parsedGroups.success) {
          throw new GraphFailure('response malformed');
        }
        succeeded();
        if (!parsedState.data.accountEnabled) return { kind: 'disabled' };
        const member = new Set(parsedGroups.data.value.map((id) => id.toLowerCase()));
        const validFrom = parsedState.data.signInSessionsValidFromDateTime;
        return {
          kind: 'ok',
          inAccessGroup: member.has(access.access_group_id.toLowerCase()),
          inAdminGroup: member.has(access.admin_group_id.toLowerCase()),
          sessionsValidFrom:
            validFrom === null || validFrom === undefined ? null : new Date(validFrom),
        };
      } catch (error) {
        const reason =
          error instanceof GraphFailure
            ? error.message
            : (error as { name?: unknown }).name === 'TimeoutError'
              ? 'timeout'
              : 'unreachable';
        return failed(reason);
      }
    },

    async groupDisplayName(groupId) {
      if (now() < openUntil) return undefined;
      try {
        const response = await call(`/groups/${encodeURIComponent(groupId)}?$select=displayName`, {
          method: 'GET',
          timeout: Math.min(timeoutMs, GROUP_NAME_TIMEOUT_MS),
        });
        if (response.status === 404) {
          await response.body?.cancel();
          return null;
        }
        if (!response.ok) {
          await response.body?.cancel();
          return undefined;
        }
        const parsed = GroupName.safeParse(await response.json());
        return parsed.success ? parsed.data.displayName : undefined;
      } catch {
        return undefined;
      }
    },

    circuit: () => ({ open: now() < openUntil, consecutiveFailures: failures }),
  };
}
