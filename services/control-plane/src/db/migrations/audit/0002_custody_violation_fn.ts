// audit / 0002: audit.record_custody_violation() (security review of T16-1, SEC-F002-34, §B;
// SEC-F002-39, -40). The sealer records a checkpoint-key custody violation through this one
// SECURITY DEFINER function instead of holding the insert-only writer credential: it can record
// one fixed fact about one key, and nothing else.
//
// B2 signature (both flags, SEC-F002-40) · B3 SECURITY DEFINER, search_path pg_catalog then
// pg_temp last, every object schema-qualified, no dynamic SQL · B4 hard key allow-list and flag
// checks (22023) · B5 every field fixed here; event_id and trace_id are v4/random (DB-minted
// events, as for audit.modify_denied) · B6 org = audit.current_org() (the caller's withOrg; fails
// closed when unset; FORCE RLS applies) · B7 advisory lock + 5-minute dedupe per (org, key, flag
// pair), so the sealer can retry every poll until recorded (SEC-F002-39) · B8 EXECUTE for
// ralysa_audit_sealer only. Runs as the audit owner (migrate --audit); never edited once released.
import type { Kysely } from 'kysely';
import { exec } from '../ddl.js';

const SIGNATURE = 'audit.record_custody_violation(text, boolean, boolean)';

export async function up(db: Kysely<unknown>): Promise<void> {
  await exec(db, [
    `CREATE FUNCTION audit.record_custody_violation(
        p_key text, p_exportable boolean, p_allow_plaintext_backup boolean)
      RETURNS boolean
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_org uuid;
        v_flag text;
      BEGIN
        IF p_key IS NULL OR p_key <> 'ralysa-audit-checkpoint' THEN
          RAISE EXCEPTION 'record_custody_violation: key not allowed' USING ERRCODE = '22023';
        END IF;
        IF p_exportable IS NULL OR p_allow_plaintext_backup IS NULL
           OR NOT (p_exportable OR p_allow_plaintext_backup) THEN
          RAISE EXCEPTION 'record_custody_violation: at least one flag must be true'
            USING ERRCODE = '22023';
        END IF;
        v_org := audit.current_org();
        v_flag := CASE WHEN p_exportable THEN 'exportable' ELSE 'allow_plaintext_backup' END;
        PERFORM pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtext('custody:' || v_org::text || ':' || p_key));
        IF EXISTS (
          SELECT 1 FROM audit.audit_event
           WHERE org_id = v_org
             AND action = 'secret.custody_violation'
             AND ts > pg_catalog.clock_timestamp() - interval '5 minutes'
             AND details->>'key' = p_key
             AND (details->>'exportable')::boolean = p_exportable
             AND (details->>'allow_plaintext_backup')::boolean = p_allow_plaintext_backup
        ) THEN
          RETURN false;
        END IF;
        INSERT INTO audit.audit_event (event_id, org_id, action, actor_type, actor_user_id,
                                       actor_idp_subject, actor_service, outcome, reason_code,
                                       trace_id, source, attestation, details)
        VALUES (pg_catalog.gen_random_uuid(), v_org, 'secret.custody_violation', 'system', NULL,
                NULL, 'sealer', 'error', v_flag,
                pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''),
                'control-plane', 'server',
                pg_catalog.jsonb_build_object(
                  'key', p_key,
                  'exportable', p_exportable,
                  'allow_plaintext_backup', p_allow_plaintext_backup,
                  'flag', v_flag,
                  'db_role', session_user::text,
                  'via', 'audit.record_custody_violation'));
        RETURN true;
      END
      $fn$`,
    `REVOKE ALL ON FUNCTION ${SIGNATURE} FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO ralysa_audit_sealer`,
  ]);
}
