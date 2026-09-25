-- Ralysa control plane: database bootstrap (F-002 design §4.1, §4.5; SEC-F002-01 a/b, -25, -29).
--
-- Run ONCE PER DATABASE by the DBA as a superuser, before the migrations (`migrate --audit`, then
-- `migrate`). Idempotent: running it again changes nothing. Plain SQL with no psql
-- meta-commands, so it runs through psql or any driver's simple-query protocol.
--
-- It does NOT set passwords. Each login role's password lives in OpenBao KV
-- (kv/ralysa/control-plane/db/<role>) and is set separately over stdin as a SCRAM verifier
-- (tooling/dev-stack does this in development). Roles created here without a password can't log
-- in until then.
--
-- What it sets up:
--   1. the UTF-8 check (AC-15);
--   2. the roles, none with an elevated attribute; `ralysa_audit_owner` is NOLOGIN, and
--      `ralysa_audit_migrator` may only SET ROLE to it (no inheritance) [SEC-F002-01 a];
--   3. database privileges: CONNECT for the Ralysa roles, CREATE for the two schema owners,
--      nothing on `public`;
--   4. the superuser-owned DDL event trigger that writes `audit.schema_changed` for any DDL on the
--      `audit` or `ralysa_meta_audit` schemas [SEC-F002-01 b].
-- No Ralysa role is granted SET on `session_replication_role` [SEC-F002-25].

-- 1. UTF-8 (AC-15)
DO $$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'server_encoding is %, Ralysa needs UTF8 (AC-15)', current_setting('server_encoding');
  END IF;
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'bootstrap-roles.sql must run as a superuser (it creates an event trigger)';
  END IF;
END $$;

-- 2. Roles
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['ralysa_migrator', 'ralysa_audit_migrator', 'ralysa_cp_app',
                           'ralysa_audit_writer', 'ralysa_audit_reader', 'ralysa_audit_sealer'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', r);
    END IF;
    EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ralysa_audit_owner') THEN
    CREATE ROLE ralysa_audit_owner NOLOGIN;
  END IF;
  ALTER ROLE ralysa_audit_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END $$;

-- The break-glass audit migrator reaches the owner only through an explicit SET ROLE.
GRANT ralysa_audit_owner TO ralysa_audit_migrator WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
-- The cp migrator is never a member of the audit owner [SEC-F002-01 a].
DO $$
BEGIN
  IF pg_has_role('ralysa_migrator', 'ralysa_audit_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'ralysa_migrator must not be a member of ralysa_audit_owner';
  END IF;
END $$;

-- 3. Database privileges
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ralysa_migrator, ralysa_audit_migrator, ralysa_cp_app, '
                 'ralysa_audit_writer, ralysa_audit_reader, ralysa_audit_sealer', current_database());
  -- The two schema owners create their schemas (cp + ralysa_meta; audit + ralysa_meta_audit).
  EXECUTE format('GRANT CREATE ON DATABASE %I TO ralysa_migrator, ralysa_audit_owner', current_database());
END $$;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- 4. DDL on the audit schemas is recorded [SEC-F002-01 b]. Superuser-owned: neither the audit
-- owner nor the migrators can alter, disable or drop an event trigger.
CREATE SCHEMA IF NOT EXISTS ralysa_admin;
REVOKE ALL ON SCHEMA ralysa_admin FROM PUBLIC;

CREATE OR REPLACE FUNCTION ralysa_admin.record_audit_schema_ddl()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  obj record;
  org text;
  objects jsonb := '[]'::jsonb;
BEGIN
  IF TG_EVENT = 'ddl_command_end' THEN
    FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
      IF obj.schema_name IN ('audit', 'ralysa_meta_audit')
         OR obj.object_identity ~ '(^|[ (])(audit|ralysa_meta_audit)\.'
         OR (obj.object_type = 'schema' AND obj.object_identity IN ('audit', 'ralysa_meta_audit')) THEN
        objects := objects || jsonb_build_object('command', obj.command_tag,
                                                 'object_type', obj.object_type,
                                                 'object', obj.object_identity);
      END IF;
    END LOOP;
  ELSE
    FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
      IF obj.schema_name IN ('audit', 'ralysa_meta_audit')
         OR obj.object_identity ~ '(^|[ (])(audit|ralysa_meta_audit)\.'
         OR (obj.object_type = 'schema' AND obj.object_identity IN ('audit', 'ralysa_meta_audit')) THEN
        objects := objects || jsonb_build_object('command', 'DROP',
                                                 'object_type', obj.object_type,
                                                 'object', obj.object_identity);
      END IF;
    END LOOP;
  END IF;
  IF jsonb_array_length(objects) = 0 THEN
    RETURN;
  END IF;
  IF to_regclass('audit.audit_event') IS NULL THEN
    -- Before the audit store exists (its own first migration) or after it was dropped: the
    -- server log is the only record (log_line_prefix names the user and client).
    RAISE WARNING 'audit schema DDL not recorded in audit.audit_event (table absent): % by %',
      objects::text, session_user;
    RETURN;
  END IF;
  -- The org: the caller's app.org_id (the migrate jobs set it from config), else the one
  -- organization (Phase 0, ADR-0003), else the nil UUID (a fresh install before org bootstrap).
  org := nullif(current_setting('app.org_id', true), '');
  IF org IS NULL AND to_regclass('cp.organization') IS NOT NULL THEN
    EXECUTE 'SELECT id::text FROM cp.organization ORDER BY created_at LIMIT 1' INTO org;
  END IF;
  EXECUTE
    'INSERT INTO audit.audit_event (event_id, org_id, action, actor_type, outcome, trace_id, source, '
    '  attestation, details) VALUES (gen_random_uuid(), $1, ''audit.schema_changed'', ''system'', '
    '  ''success'', md5(random()::text || clock_timestamp()::text), ''control-plane'', ''server'', $2)'
    USING coalesce(org, '00000000-0000-0000-0000-000000000000')::uuid,
          jsonb_build_object('event', TG_EVENT, 'tag', TG_TAG, 'objects', objects,
                             'db_user', session_user::text, 'current_user', current_user::text);
END
$fn$;
REVOKE ALL ON FUNCTION ralysa_admin.record_audit_schema_ddl() FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'ralysa_audit_ddl_end') THEN
    CREATE EVENT TRIGGER ralysa_audit_ddl_end ON ddl_command_end
      EXECUTE FUNCTION ralysa_admin.record_audit_schema_ddl();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'ralysa_audit_ddl_drop') THEN
    CREATE EVENT TRIGGER ralysa_audit_ddl_drop ON sql_drop
      EXECUTE FUNCTION ralysa_admin.record_audit_schema_ddl();
  END IF;
  ALTER EVENT TRIGGER ralysa_audit_ddl_end ENABLE ALWAYS;
  ALTER EVENT TRIGGER ralysa_audit_ddl_drop ENABLE ALWAYS;
END $$;
