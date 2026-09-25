// OpenBao (or API-compatible Vault) behind the ports (F-002 design §3.7, D-7).
import type { Fetch } from '../platform.js';
import type { KeyCustody, RuntimeEnv, SecretStore, VaultAuth } from '../ports.js';
import { createAuthedBao } from './auth.js';
import { createBaoHttp } from './http.js';
import { createKv2SecretStore } from './kv2.js';
import { createTransitKeyCustody } from './transit.js';

export interface OpenBaoOptions {
  addr: string;
  auth: VaultAuth;
  env: RuntimeEnv;
  allowAppRole?: boolean;
  transitMount?: string;
  timeoutMs?: number;
  fetch?: Fetch;
}

/** Throws SecretsError('config') for an auth method the environment refuses. */
export function createOpenBao(options: OpenBaoOptions): { secrets: SecretStore; keys: KeyCustody } {
  const http = createBaoHttp({
    addr: options.addr,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const bao = createAuthedBao(http, {
    auth: options.auth,
    env: options.env,
    ...(options.allowAppRole === undefined ? {} : { allowAppRole: options.allowAppRole }),
  });
  return {
    secrets: createKv2SecretStore(bao),
    keys: createTransitKeyCustody(bao, options.transitMount ?? 'transit'),
  };
}

export { assertAuthAllowed } from './auth.js';
export { kvDataPath } from './kv2.js';
export { checkCustody, pemToJwk } from './transit.js';
