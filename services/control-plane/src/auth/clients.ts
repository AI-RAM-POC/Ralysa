// The static client registry (F-002 design §3.1, §3.2.7; AC-3): `ralysa-cli` is a PUBLIC client
// (no secret, ever); services authenticate with private_key_jwt through their own Transit key.
// No client_secret method exists at RTS.
import { CLI_CLIENT_ID } from '@ralysa/protocol/auth';
import type { ServeConfig } from '../config/schema.js';

export interface ServiceClient {
  name: string;
  clientId: string;
  transitKey: string;
  auditActions: readonly string[];
}

export interface ClientRegistry {
  cliClientId: typeof CLI_CLIENT_ID;
  service(clientId: string): ServiceClient | undefined;
  services(): readonly ServiceClient[];
}

export function createClientRegistry(config: Pick<ServeConfig, 'services'>): ClientRegistry {
  const byId = new Map(
    config.services.map((s) => [
      s.client_id,
      {
        name: s.name,
        clientId: s.client_id,
        transitKey: s.transit_key,
        auditActions: s.audit_actions,
      },
    ]),
  );
  return {
    cliClientId: CLI_CLIENT_ID,
    service: (clientId) => byId.get(clientId),
    services: () => [...byId.values()],
  };
}
