// cp / 0002: organization, users, IdP groups and memberships (F-002 design §4.4; ADR-0003,
// ADR-0011). `organization.region` is immutable (residency, SR-04).
import type { Kysely } from 'kysely';
import { exec, orgIsolation } from '../ddl.js';

const TABLES = ['cp.organization', 'cp.app_user', 'cp.idp_group', 'cp.group_membership'];

export async function up(db: Kysely<unknown>): Promise<void> {
  await exec(db, [
    `CREATE TABLE cp.organization (
      id uuid PRIMARY KEY,
      org_id uuid GENERATED ALWAYS AS (id) STORED NOT NULL,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
      residency text NOT NULL CHECK (residency IN ('in_country', 'in_region')),
      region text NOT NULL CHECK (char_length(region) BETWEEN 1 AND 40),
      deployment_model text NOT NULL CHECK (deployment_model IN ('dedicated', 'on_prem', 'air_gapped')),
      settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE FUNCTION cp.organization_region_immutable() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog
      AS $fn$
      BEGIN
        IF NEW.region IS DISTINCT FROM OLD.region THEN
          RAISE EXCEPTION 'organization.region is immutable (residency)' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $fn$`,
    `REVOKE ALL ON FUNCTION cp.organization_region_immutable() FROM PUBLIC`,
    `CREATE TRIGGER organization_region_immutable BEFORE UPDATE ON cp.organization
      FOR EACH ROW EXECUTE FUNCTION cp.organization_region_immutable()`,
    `ALTER TABLE cp.organization ENABLE ALWAYS TRIGGER organization_region_immutable`,

    `CREATE TABLE cp.app_user (
      id uuid PRIMARY KEY,
      org_id uuid NOT NULL REFERENCES cp.organization (id),
      idp_issuer text NOT NULL,
      idp_tenant_id text NOT NULL,
      idp_subject text NOT NULL,
      email text,
      display_name text,
      locale text NOT NULL DEFAULT 'en',
      department_id uuid,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      revoked_before timestamptz,
      last_sign_in_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (org_id, idp_issuer, idp_subject)
    )`,

    // Object ids only; non-GUID group claims are never stored [SEC-F002-08].
    `CREATE TABLE cp.idp_group (
      id uuid PRIMARY KEY,
      org_id uuid NOT NULL REFERENCES cp.organization (id),
      idp_group_id uuid NOT NULL,
      display_name text,
      role text CHECK (role IN ('access', 'platform_admin')),
      name_refreshed_at timestamptz,
      UNIQUE (org_id, idp_group_id)
    )`,

    `CREATE TABLE cp.group_membership (
      org_id uuid NOT NULL REFERENCES cp.organization (id),
      user_id uuid NOT NULL REFERENCES cp.app_user (id),
      group_id uuid NOT NULL REFERENCES cp.idp_group (id),
      source text NOT NULL CHECK (source IN ('token_claim', 'graph_check')),
      observed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, user_id, group_id)
    )`,
    `CREATE INDEX group_membership_org_group ON cp.group_membership (org_id, group_id)`,

    ...TABLES.flatMap((table) => orgIsolation(table, 'cp.current_org')),
    `REVOKE ALL ON ${TABLES.join(', ')} FROM PUBLIC`,
    `GRANT SELECT, INSERT, UPDATE ON cp.organization, cp.app_user, cp.idp_group TO ralysa_cp_app`,
    // Memberships are replaced at each sign-in and refresh.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON cp.group_membership TO ralysa_cp_app`,
  ]);
}
