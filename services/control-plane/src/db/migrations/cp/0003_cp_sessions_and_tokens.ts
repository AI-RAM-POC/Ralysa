// cp / 0003: sessions, refresh-token families, codes, IdP requests, replay caches and signing-key
// versions (F-002 design §3.2, §4.4). Secrets are stored as SHA-256 hashes only.
import type { Kysely } from 'kysely';
import { exec, orgIsolation } from '../ddl.js';

const TABLES = [
  'cp.auth_session',
  'cp.refresh_token',
  'cp.authorization_code',
  'cp.idp_auth_request',
  'cp.idp_token_replay',
  'cp.client_assertion_replay',
  'cp.signing_key_version',
];
const HASH = (column: string) => `${column} bytea NOT NULL CHECK (octet_length(${column}) = 32)`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await exec(db, [
    `CREATE TABLE cp.auth_session (
      id uuid PRIMARY KEY,
      org_id uuid NOT NULL REFERENCES cp.organization (id),
      user_id uuid NOT NULL REFERENCES cp.app_user (id),
      client_id text NOT NULL,
      surface text NOT NULL,
      flow text NOT NULL CHECK (flow IN ('idp_device', 'loopback_pkce')),
      status text NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
      roles text[] NOT NULL DEFAULT '{}' CHECK (roles <@ ARRAY['user', 'platform_admin']::text[]),
      device_label text CHECK (char_length(device_label) <= 100),
      created_ip inet,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_refresh_at timestamptz,
      absolute_expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      revoked_reason text
    )`,
    `CREATE INDEX auth_session_org_user ON cp.auth_session (org_id, user_id)`,
    `CREATE INDEX auth_session_revoked ON cp.auth_session (org_id, revoked_at) WHERE revoked_at IS NOT NULL`,
    `CREATE INDEX auth_session_active_flow ON cp.auth_session (org_id, flow) WHERE status = 'active'`,

    `CREATE TABLE cp.refresh_token (
      id uuid PRIMARY KEY,
      org_id uuid NOT NULL REFERENCES cp.organization (id),
      session_id uuid NOT NULL REFERENCES cp.auth_session (id),
      parent_id uuid REFERENCES cp.refresh_token (id),
      ${HASH('token_hash')} UNIQUE,
      status text NOT NULL CHECK (status IN ('active', 'rotated', 'revoked')),
      issued_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    )`,
    `CREATE INDEX refresh_token_org_session ON cp.refresh_token (org_id, session_id)`,

    `CREATE TABLE cp.authorization_code (
      ${HASH('code_hash')} PRIMARY KEY,
      org_id uuid NOT NULL REFERENCES cp.organization (id),
      client_id text NOT NULL,
      redirect_uri text NOT NULL,
      code_challenge text NOT NULL,
      session_id uuid NOT NULL REFERENCES cp.auth_session (id),
      callback_ip inet,
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    )`,

    `CREATE TABLE cp.idp_auth_request (
      ${HASH('state_hash')} PRIMARY KEY,
      org_id uuid NOT NULL REFERENCES cp.organization (id),
      ${HASH('browser_binding_hash')},
      client_redirect_uri text NOT NULL,
      client_state text NOT NULL,
      client_code_challenge text NOT NULL,
      authorize_ip inet,
      idp_code_verifier text NOT NULL,
      idp_nonce text NOT NULL,
      expires_at timestamptz NOT NULL
    )`,

    `CREATE TABLE cp.idp_token_replay (
      ${HASH('token_id_hash')} PRIMARY KEY,
      org_id uuid NOT NULL REFERENCES cp.organization (id),
      expires_at timestamptz NOT NULL
    )`,
    `CREATE TABLE cp.client_assertion_replay (
      ${HASH('jti_hash')} PRIMARY KEY,
      org_id uuid NOT NULL REFERENCES cp.organization (id),
      expires_at timestamptz NOT NULL
    )`,

    `CREATE TABLE cp.signing_key_version (
      kid text PRIMARY KEY,
      org_id uuid NOT NULL REFERENCES cp.organization (id),
      version integer NOT NULL CHECK (version >= 1),
      public_jwk jsonb NOT NULL CHECK (NOT (public_jwk ? 'd')),
      published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      activated_at timestamptz,
      superseded_at timestamptz,
      retired_at timestamptz,
      UNIQUE (org_id, version)
    )`,

    ...TABLES.flatMap((table) => orgIsolation(table, 'cp.current_org')),
    `REVOKE ALL ON ${TABLES.join(', ')} FROM PUBLIC`,
    `GRANT SELECT, INSERT, UPDATE ON ${TABLES.join(', ')} TO ralysa_cp_app`,
    // DELETE only on the short-lived tables (§4.1).
    `GRANT DELETE ON cp.refresh_token, cp.authorization_code, cp.idp_auth_request,
       cp.idp_token_replay, cp.client_assertion_replay TO ralysa_cp_app`,
  ]);
}
