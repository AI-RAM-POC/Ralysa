// Static checks of the migration sets and withOrg's input rule (the database behaviour itself is
// covered by test/integration/db.int.ts).
import { AuditEventInput } from '@ralysa/protocol/audit';
import { describe, expect, it } from 'vitest';
import { assertOrgId } from '../src/db/kysely.js';
import { MIGRATION_SETS } from '../src/db/migrate.js';
import { WRITER_COLUMNS } from '../src/db/migrations/audit/0001_audit_store.js';

describe('migration sets', () => {
  it('are ordered, up-only and keep their history in the ralysa_meta schemas', () => {
    expect(Object.keys(MIGRATION_SETS.audit.migrations)).toEqual([
      '0001_audit_store',
      '0002_custody_violation_fn',
    ]);
    expect(Object.keys(MIGRATION_SETS.cp.migrations)).toEqual([
      '0001_schemas_and_rls_helpers',
      '0002_cp_identity',
      '0003_cp_sessions_and_tokens',
      '0004_usage_credential_governance',
      '0005_governance_epoch',
      '0006_authorization_code_sign_in',
    ]);
    for (const set of Object.values(MIGRATION_SETS)) {
      expect(set.schema).toMatch(/^ralysa_meta(_audit)?$/);
      for (const migration of Object.values(set.migrations))
        expect(Object.keys(migration)).not.toContain('down');
    }
    expect(MIGRATION_SETS.audit).toMatchObject({
      role: 'ralysa_audit_migrator',
      setRole: 'ralysa_audit_owner',
    });
    expect(MIGRATION_SETS.cp).toMatchObject({ role: 'ralysa_migrator' });
    expect(MIGRATION_SETS.cp).not.toHaveProperty('setRole');
  });

  it('the writer column grant covers every input envelope field and no server column [AR-8]', () => {
    const flattened = Object.keys(AuditEventInput.shape).flatMap((key) => {
      if (key === 'actor')
        return ['actor_type', 'actor_user_id', 'actor_idp_subject', 'actor_service'];
      if (key === 'act') return ['act_sub'];
      if (key === 'resource') return ['resource_type', 'resource_id'];
      return [key];
    });
    const server = ['org_id', 'source', 'attestation', 'client_seq'];
    expect([...WRITER_COLUMNS].sort()).toEqual([...flattened, ...server].sort());
    for (const column of ['ts', 'ingest_seq', 'schema_version']) {
      expect(WRITER_COLUMNS as readonly string[]).not.toContain(column);
    }
  });
});

describe('withOrg input', () => {
  it.each(['0192a0c0-0000-7000-8000-00000000d0e1'])('accepts %s', (id) => {
    expect(() => {
      assertOrgId(id);
    }).not.toThrow();
  });
  it.each([
    '',
    'x',
    "0192a0c0-0000-7000-8000-00000000d0e1'; --",
    '0192A0C0-0000-7000-8000-00000000D0E1',
  ])('refuses %j', (id) => {
    expect(() => {
      assertOrgId(id);
    }).toThrow(/UUID/);
  });
});
