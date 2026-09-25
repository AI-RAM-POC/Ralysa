// A valid serve config for tests (production shape unless overridden).
import { parseConfig } from '../../src/config/load.js';
import { ServeConfig } from '../../src/config/schema.js';

export const ORG_ID = '0192f0a0-7b3c-7d4e-8f00-00000000000f';
export const TENANT = '4f1c2e3d-0000-4000-8000-0000000000aa';
const kv = (key: string) => `kv/ralysa/control-plane/${key}`;

export function serveConfigInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    org: {
      id: ORG_ID,
      name: 'Org',
      residency: 'in_country',
      region: 'qa-doha',
      deployment_model: 'on_prem',
    },
    vault: {
      addr: 'https://bao.internal:8200',
      auth: { method: 'kubernetes', role: 'ralysa-cp-serve' },
    },
    db: { host: 'db', port: 5432, database: 'ralysa', ssl: true },
    public_base_url: 'https://ralysa.example.qa',
    listen: { host: '127.0.0.1', port: 0 },
    signing_key: 'ralysa-rts-signing',
    idp: {
      kind: 'entra',
      tenant_id: TENANT,
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      rts_client_id: '4f1c2e3d-0000-4000-8000-0000000000bb',
      allowed_public_client_ids: ['4f1c2e3d-0000-4000-8000-0000000000cc'],
      signin_scope: 'api://ralysa-rts/Ralysa.SignIn',
      client_secret_path: kv('idp-client-secret'),
      graph_base_url: 'https://graph.microsoft.com',
    },
    access: {
      access_group_id: '4f1c2e3d-0000-4000-8000-0000000000d1',
      admin_group_id: '4f1c2e3d-0000-4000-8000-0000000000d2',
    },
    audit_hmac_path: kv('audit-hmac'),
    db_credentials: {
      cp_app: kv('db/cp_app'),
      audit_writer: kv('db/audit_writer'),
      audit_reader: kv('db/audit_reader'),
    },
    services: [
      {
        name: 'model-gateway',
        client_id: 'svc:model-gateway',
        transit_key: 'ralysa-svc-model-gateway',
        audit_actions: ['model.call.completed', 'auth.token_rejected'],
      },
    ],
    ...overrides,
  };
}

export const serveConfig = (overrides: Record<string, unknown> = {}): ServeConfig =>
  parseConfig(ServeConfig, serveConfigInput(overrides));
