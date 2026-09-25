// cp / 0004: usage records (written by model-gateway, F-004), credential references, the
// kill-switch table (F-012 writes) and client audit cursors (F-002 design §4.4; [AR-14]).
import type { Kysely } from 'kysely';
import { exec, orgIsolation } from '../ddl.js';

const TABLES = ['cp.usage_record', 'cp.credential', 'cp.kill_switch', 'cp.client_audit_cursor'];

export async function up(db: Kysely<unknown>): Promise<void> {
  await exec(db, [
    `CREATE TABLE cp.usage_record (
      id uuid PRIMARY KEY,
      org_id uuid NOT NULL REFERENCES cp.organization (id),
      ts timestamptz NOT NULL,
      user_id uuid,
      dept_id uuid,
      session_id text,
      trace_id text CHECK (trace_id ~ '^[0-9a-f]{32}$'),
      kind text NOT NULL CHECK (kind IN ('model', 'tool', 'sandbox_seconds')),
      model text,
      endpoint_id text,
      tokens_in integer CHECK (tokens_in >= 0),
      tokens_out integer CHECK (tokens_out >= 0),
      cache_read integer CHECK (cache_read >= 0),
      cache_write integer CHECK (cache_write >= 0),
      cache_hits integer CHECK (cache_hits >= 0),
      cost numeric(12, 4),
      credits numeric(12, 4),
      endpoint_region text,
      inference_region text,
      inference_region_source text CHECK (inference_region_source IN ('registry_declared', 'provider_reported')),
      byom boolean,
      pool_id text,
      price_book_version text,
      connector_id text
    )`,
    `CREATE INDEX usage_record_org_ts ON cp.usage_record (org_id, ts)`,
    `CREATE INDEX usage_record_org_user_ts ON cp.usage_record (org_id, user_id, ts)`,

    // References only: the value stays in OpenBao (AC-9).
    `CREATE TABLE cp.credential (
      id uuid PRIMARY KEY,
      org_id uuid NOT NULL REFERENCES cp.organization (id),
      kind text NOT NULL CHECK (kind IN ('idp_client_secret', 'signing_key', 'checkpoint_key',
                                         'service_key', 'db_role', 'audit_hmac')),
      vault_path text NOT NULL CHECK (vault_path ~ '^(kv|transit)/[a-z0-9/_.-]{1,200}$'),
      owner_scope text NOT NULL CHECK (owner_scope ~ '^(org|service:[a-z0-9-]{1,64})$'),
      current_version integer,
      rotated_at timestamptz,
      UNIQUE (org_id, kind, owner_scope)
    )`,

    `CREATE TABLE cp.kill_switch (
      id uuid PRIMARY KEY,
      org_id uuid NOT NULL REFERENCES cp.organization (id),
      scope text NOT NULL CHECK (scope IN ('tenant', 'department', 'pack', 'agent')),
      scope_id text,
      active boolean NOT NULL DEFAULT true,
      reason text,
      activated_by uuid,
      activated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX kill_switch_org_active ON cp.kill_switch (org_id, active)`,

    `CREATE TABLE cp.client_audit_cursor (
      org_id uuid NOT NULL REFERENCES cp.organization (id),
      user_id uuid NOT NULL REFERENCES cp.app_user (id),
      sid uuid NOT NULL,
      session_id text NOT NULL CHECK (char_length(session_id) <= 64),
      last_seq bigint NOT NULL DEFAULT 0,
      open_gaps int8multirange NOT NULL DEFAULT '{}',
      final_seq bigint,
      ended_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, user_id, session_id)
    )`,
    `CREATE INDEX client_audit_cursor_open ON cp.client_audit_cursor (org_id, sid) WHERE ended_at IS NULL`,

    ...TABLES.flatMap((table) => orgIsolation(table, 'cp.current_org')),
    `REVOKE ALL ON ${TABLES.join(', ')} FROM PUBLIC`,
    `GRANT SELECT, INSERT, UPDATE ON cp.credential, cp.client_audit_cursor TO ralysa_cp_app`,
    // The kill-switch port is read-only here (F-012 writes).
    `GRANT SELECT ON cp.kill_switch TO ralysa_cp_app`,
    // usage_record: ralysa_usage_writer's INSERT arrives with that role in F-004.
  ]);
}
