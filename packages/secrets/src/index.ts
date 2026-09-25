// @ralysa/secrets: SecretStore and KeyCustody ports, the OpenBao KV v2 and Transit adapters over
// fetch, and in-memory doubles (F-002 design §3.7). Isomorphic: no DOM, no Node built-ins.
export const PACKAGE_NAME = '@ralysa/secrets';

export function packageName(): string {
  return PACKAGE_NAME;
}

export { CustodyViolationError, SecretsError, type SecretsErrorCode } from './errors.js';
export type {
  KeyCustody,
  KeyDescription,
  PublicJwk,
  PublicKeyVersion,
  RuntimeEnv,
  SecretStore,
  SecretValue,
  VaultAuth,
} from './ports.js';
export {
  type OpenBaoOptions,
  assertAuthAllowed,
  checkCustody,
  createOpenBao,
  kvDataPath,
  pemToJwk,
} from './openbao/index.js';
export {
  type InMemoryKeyCustody,
  createInMemoryKeyCustody,
} from './memory/in-memory-key-custody.js';
export {
  type InMemorySecretStore,
  createInMemorySecretStore,
} from './memory/in-memory-secret-store.js';
export type { Fetch, FetchInit, FetchResponse } from './platform.js';
