// Opens OpenBao for an entry point from its config (F-002 design §3.7, §6.5): the entry point's
// own role, the auth material read from the platform (ServiceAccount token file, secret_id file,
// or in dev/test an environment variable), never from config.
import { readFile } from 'node:fs/promises';
import { type KeyCustody, type SecretStore, type VaultAuth, createOpenBao } from '@ralysa/secrets';
import type { CommonConfig } from '../config/schema.js';

export function vaultAuthFrom(
  config: CommonConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): VaultAuth {
  const auth = config.vault.auth;
  switch (auth.method) {
    case 'kubernetes':
      return {
        method: 'kubernetes',
        role: auth.role,
        jwt: async () => (await readFile(auth.jwt_path, 'utf8')).trim(),
      };
    case 'approle':
      return {
        method: 'approle',
        roleId: auth.role_id,
        secretId: async () => (await readFile(auth.secret_id_path, 'utf8')).trim(),
      };
    case 'token': {
      const token = env[auth.token_env];
      if (token === undefined || token === '') {
        throw new Error(`vault token auth: environment variable ${auth.token_env} is not set`);
      }
      return { method: 'token', token };
    }
  }
}

export function openVault(config: CommonConfig): { secrets: SecretStore; keys: KeyCustody } {
  return createOpenBao({
    addr: config.vault.addr,
    auth: vaultAuthFrom(config),
    env: config.env,
    allowAppRole: config.vault.allow_approle,
    transitMount: config.vault.transit_mount,
  });
}
