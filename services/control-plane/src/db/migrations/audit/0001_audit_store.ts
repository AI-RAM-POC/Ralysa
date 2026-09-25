// audit / 0001: the audit store (F-002 design §4.3–§4.5; AC-17; SEC-F002-01, -25; [AR-5]–[AR-8]).
// Runs as `ralysa_audit_migrator` after `SET ROLE ralysa_audit_owner`, so the NOLOGIN owner owns
// the schema, tables, functions and triggers. Never edited after release (migrations.lock.json).
import type { Kysely } from 'kysely';
import { currentOrgFunction, exec, orgIsolation } from '../ddl.js';

const TABLES = ['audit.audit_event', 'audit.audit_seal', 'audit.audit_checkpoint'] as const;

/** Envelope columns a writer may set; `ts`, `ingest_seq` and `schema_version` are the server's. */
export const WRITER_COLUMNS = [
  'event_id',
  'org_id',
  'action',
  'actor_type',
  'actor_user_id',
  'actor_idp_subject',
  'actor_service',
  'act_sub',
  'surface',
  'resource_type',
  'resource_id',
  'operation',
  'outcome',
  'reason_code',
  'session_id',
  'turn_id',
  'request_id',
  'tool_call_id',
  'trace_id',
  'span_id',
  'policy_version',
  'entitlement_version',
  'tier',
  'classification',
  'endpoint_id',
  'endpoint_region',
  'inference_region',
  'inference_region_source',
  'locality',
  'tokens_in',
  'tokens_out',
  'cache_read_tokens',
  'cache_write_tokens',
  'payload_hash',
  'source',
  'attestation',
  'client_seq',
  'details',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await exec(db, [
    `CREATE SCHEMA audit`,
    `REVOKE ALL ON SCHEMA audit FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA audit TO ralysa_audit_writer, ralysa_audit_reader, ralysa_audit_sealer`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA audit REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
    currentOrgFunction('audit'),
    `REVOKE ALL ON FUNCTION audit.current_org() FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION audit.current_org() TO ralysa_audit_writer, ralysa_audit_reader, ralysa_audit_sealer`,

    // The envelope as columns (§3.5, §4.4). Checks mirror the protocol enums; the canonical form
    // for hashing is rebuilt from these columns by rowToEnvelope() (T06) [AR-5].
    `CREATE TABLE audit.audit_event (
      event_id uuid PRIMARY KEY,
      org_id uuid NOT NULL,
      schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
      ts timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
      ingest_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      action text NOT NULL CHECK (action ~ '^[a-z_]+(\\.[a-z_]+){1,3}$'),
      actor_type text NOT NULL CHECK (actor_type IN ('user', 'service', 'system')),
      actor_user_id uuid,
      actor_idp_subject text CHECK (char_length(actor_idp_subject) <= 128),
      actor_service text CHECK (char_length(actor_service) <= 64),
      act_sub text CHECK (char_length(act_sub) <= 200),
      surface text CHECK (surface IN ('cli', 'desktop', 'web', 'automation', 'console')),
      resource_type text CHECK (char_length(resource_type) <= 40),
      resource_id text CHECK (char_length(resource_id) <= 200),
      operation text CHECK (char_length(operation) <= 32),
      outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied', 'error', 'cancelled',
                                               'approved', 'rejected', 'expired')),
      reason_code text CHECK (char_length(reason_code) <= 64),
      session_id text CHECK (char_length(session_id) <= 64),
      turn_id text CHECK (char_length(turn_id) <= 64),
      request_id text CHECK (char_length(request_id) <= 64),
      tool_call_id text CHECK (char_length(tool_call_id) <= 64),
      trace_id text NOT NULL CHECK (trace_id ~ '^[0-9a-f]{32}$'),
      span_id text CHECK (span_id ~ '^[0-9a-f]{16}$'),
      policy_version text CHECK (char_length(policy_version) <= 64),
      entitlement_version integer,
      tier text CHECK (tier IN ('T1', 'T2', 'T3')),
      classification text CHECK (char_length(classification) <= 16),
      endpoint_id text CHECK (char_length(endpoint_id) <= 100),
      endpoint_region text CHECK (char_length(endpoint_region) <= 40),
      inference_region text CHECK (char_length(inference_region) <= 40),
      inference_region_source text CHECK (inference_region_source IN ('registry_declared', 'provider_reported')),
      locality text CHECK (locality IN ('local', 'in_country', 'in_region', 'global')),
      tokens_in integer CHECK (tokens_in >= 0),
      tokens_out integer CHECK (tokens_out >= 0),
      cache_read_tokens integer CHECK (cache_read_tokens >= 0),
      cache_write_tokens integer CHECK (cache_write_tokens >= 0),
      payload_hash text CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      source text NOT NULL CHECK (source IN ('control-plane', 'model-gateway', 'mcp-gateway',
                                             'workspace-runtime', 'agent-host-server', 'agent-host-local')),
      attestation text NOT NULL CHECK (attestation IN ('server', 'client')),
      client_seq bigint,
      details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object')
    )`,
    `CREATE INDEX audit_event_org_ts ON audit.audit_event (org_id, ts, event_id)`,
    `CREATE INDEX audit_event_org_actor_ts ON audit.audit_event (org_id, actor_user_id, ts)`,
    `CREATE INDEX audit_event_org_action_ts ON audit.audit_event (org_id, action, ts)`,

    // One hash chain per (org_id, shard); the PK is the fork guard (§4.6).
    `CREATE TABLE audit.audit_seal (
      org_id uuid NOT NULL,
      shard text NOT NULL,
      seq bigint NOT NULL CHECK (seq >= 1),
      event_id uuid NOT NULL UNIQUE REFERENCES audit.audit_event (event_id),
      event_hash bytea NOT NULL CHECK (octet_length(event_hash) = 32),
      prev_hash bytea NOT NULL CHECK (octet_length(prev_hash) = 32),
      hash bytea NOT NULL CHECK (octet_length(hash) = 32),
      sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (org_id, shard, seq)
    )`,

    // Transit-signed chain heads (§4.7, D-28).
    `CREATE TABLE audit.audit_checkpoint (
      org_id uuid NOT NULL,
      shard text NOT NULL,
      seq bigint NOT NULL CHECK (seq >= 1),
      hash bytea NOT NULL CHECK (octet_length(hash) = 32),
      checkpoint_ts timestamptz(3) NOT NULL,
      key_version integer NOT NULL CHECK (key_version >= 1),
      signature bytea NOT NULL,
      PRIMARY KEY (org_id, shard, seq)
    )`,
    `CREATE INDEX audit_checkpoint_org_shard_ts ON audit.audit_checkpoint (org_id, shard, checkpoint_ts)`,

    ...TABLES.flatMap((table) => orgIsolation(table, 'audit.current_org')),

    // Grants (§4.1). The writer inserts the writer columns only: no SELECT, UPDATE, DELETE or
    // TRUNCATE, so those fail with 42501 before any trigger runs [AR-8].
    `REVOKE ALL ON ${TABLES.join(', ')} FROM PUBLIC`,
    `GRANT INSERT (${WRITER_COLUMNS.join(', ')}) ON audit.audit_event TO ralysa_audit_writer`,
    `GRANT SELECT ON ${TABLES.join(', ')} TO ralysa_audit_reader`,
    `GRANT SELECT ON audit.audit_event TO ralysa_audit_sealer`,
    `GRANT SELECT, INSERT ON audit.audit_seal, audit.audit_checkpoint TO ralysa_audit_sealer`,

    // Insert-only for roles that could modify (the owner, a superuser) [SEC-F002-25]: the row
    // trigger skips the row and counts it in a transaction-local setting; the statement trigger
    // writes ONE audit.modify_denied per statement with the count, then restores the caller's
    // app.org_id. Both SECURITY DEFINER as the owner with a fixed search_path.
    `CREATE FUNCTION audit.reject_modify_row() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, audit
      AS $fn$
      DECLARE
        n bigint := coalesce(nullif(current_setting('ralysa.modify_denied_rows', true), '')::bigint, 0) + 1;
      BEGIN
        PERFORM set_config('ralysa.modify_denied_rows', n::text, true);
        IF n = 1 THEN
          PERFORM set_config('ralysa.modify_denied_org', OLD.org_id::text, true);
        END IF;
        RETURN NULL;
      END
      $fn$`,
    `CREATE FUNCTION audit.reject_modify_stmt() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, audit
      AS $fn$
      DECLARE
        n bigint := coalesce(nullif(current_setting('ralysa.modify_denied_rows', true), '')::bigint, 0);
        org text := nullif(current_setting('ralysa.modify_denied_org', true), '');
        caller_org text := current_setting('app.org_id', true);
      BEGIN
        PERFORM set_config('ralysa.modify_denied_rows', '0', true);
        PERFORM set_config('ralysa.modify_denied_org', '', true);
        IF n = 0 OR org IS NULL THEN
          RETURN NULL;
        END IF;
        PERFORM set_config('app.org_id', org, true);
        INSERT INTO audit.audit_event (event_id, org_id, action, actor_type, actor_service, outcome,
                                       reason_code, trace_id, source, attestation, details)
        VALUES (gen_random_uuid(), org::uuid, 'audit.modify_denied', 'system', 'audit-store', 'denied',
                'insert_only', md5(random()::text || clock_timestamp()::text), 'control-plane', 'server',
                jsonb_build_object('op', TG_OP, 'table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
                                   'db_role', session_user::text, 'row_count', n));
        PERFORM set_config('app.org_id', coalesce(caller_org, ''), true);
        RETURN NULL;
      END
      $fn$`,
    // The counters live in settings the caller could pre-set (e.g. rows = -1 to cancel the
    // count). A BEFORE statement trigger resets both, so only this statement's rows count.
    `CREATE FUNCTION audit.reject_modify_reset() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, audit
      AS $fn$
      BEGIN
        PERFORM set_config('ralysa.modify_denied_rows', '0', true);
        PERFORM set_config('ralysa.modify_denied_org', '', true);
        RETURN NULL;
      END
      $fn$`,
    `CREATE FUNCTION audit.reject_truncate() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog
      AS $fn$
      BEGIN
        RAISE EXCEPTION 'audit tables are insert-only: TRUNCATE %.% refused', TG_TABLE_SCHEMA, TG_TABLE_NAME
          USING ERRCODE = 'insufficient_privilege';
      END
      $fn$`,
    `REVOKE ALL ON FUNCTION audit.reject_modify_reset(), audit.reject_modify_row(), audit.reject_modify_stmt(), audit.reject_truncate() FROM PUBLIC`,
    ...TABLES.flatMap((table) => {
      const name = table.split('.')[1] ?? table;
      return [
        `CREATE TRIGGER ${name}_reject_modify_reset BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_modify_reset()`,
        `CREATE TRIGGER ${name}_reject_modify_row BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION audit.reject_modify_row()`,
        `CREATE TRIGGER ${name}_reject_modify_stmt AFTER UPDATE OR DELETE ON ${table}
          FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_modify_stmt()`,
        `CREATE TRIGGER ${name}_reject_truncate BEFORE TRUNCATE ON ${table}
          FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_truncate()`,
        // ALWAYS: also under session_replication_role = replica [SEC-F002-25].
        `ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${name}_reject_modify_reset`,
        `ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${name}_reject_modify_row`,
        `ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${name}_reject_modify_stmt`,
        `ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${name}_reject_truncate`,
      ];
    }),
  ]);
}
