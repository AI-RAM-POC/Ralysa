// F-002-T02 smoke test: the dev stack is up and bootstrapped. Postgres is UTF-8 with SCRAM and
// the attributable log prefix; every Ralysa login role exists without elevated attributes and
// logs in with its OpenBao KV password; OpenBao has the non-exportable Transit keys.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBootstrapped, readDbPassword, TRANSIT_KEYS } from '../../src/bootstrap-vault.ts';
import { dataOf, devStackOrSkip, expectOk, rootBao } from '../../src/harness/index.ts';
import { DB_ROLES } from '../../src/stack.ts';

const stack = await devStackOrSkip();

describe.skipIf(stack === undefined)('dev stack smoke (F-002-T02)', () => {
  // `stack` is only read inside hooks and tests: the describe body still runs at collection time
  // when the suite is skipped, and must not touch the stack there (see static-guard.test.ts).
  let superuser: pg.Client | undefined;
  beforeAll(async () => {
    superuser = new pg.Client({ ...stack!.postgres });
    await superuser.connect();
  });
  const db = (): pg.Client => {
    if (superuser === undefined) throw new Error('beforeAll did not connect');
    return superuser;
  };
  afterAll(async () => {
    await superuser?.end();
  });

  const setting = async (name: string): Promise<string> => {
    const result = await db().query<{ value: string }>('SELECT current_setting($1) AS value', [
      name,
    ]);
    return result.rows[0]!.value;
  };

  it('Postgres is UTF-8 (AC-15), stores SCRAM verifiers and logs user, db, app and client', async () => {
    expect(await setting('server_encoding')).toBe('UTF8');
    expect(await setting('password_encryption')).toBe('scram-sha-256');
    const prefix = await setting('log_line_prefix');
    for (const part of ['user=%u', 'db=%d', 'app=%a', 'client=%h']) expect(prefix).toContain(part);
  });

  it('creates every login role with no elevated attribute and a SCRAM password', async () => {
    const result = await db().query<{
      rolname: string;
      elevated: boolean;
      scram: boolean;
      rolcanlogin: boolean;
    }>(
      `SELECT rolname, rolcanlogin,
              (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS elevated,
              rolpassword LIKE 'SCRAM-SHA-256$%' AS scram
         FROM pg_authid WHERE rolname = ANY($1) ORDER BY rolname`,
      [DB_ROLES.map((r) => r.role)],
    );
    expect(result.rows.map((r) => r.rolname).sort()).toEqual(DB_ROLES.map((r) => r.role).sort());
    for (const row of result.rows) {
      expect(row).toMatchObject({ rolcanlogin: true, elevated: false, scram: true });
    }
  });

  it.each(DB_ROLES.map((r) => [r.role, r.key] as const))(
    '%s logs in with the password from KV (verifier computed by the bootstrap)',
    async (role, key) => {
      const password = await readDbPassword(rootBao(stack!), key);
      const client = new pg.Client({ ...stack!.postgres, user: role, password });
      await client.connect();
      try {
        const result = await client.query<{ who: string }>('SELECT current_user AS who');
        expect(result.rows[0]?.who).toBe(role);
      } finally {
        await client.end();
      }
    },
  );

  it('bootstrap recorded its completion marker (read by the harness probe)', async () => {
    expect(await isBootstrapped(rootBao(stack!))).toBe(true);
  });

  it('OpenBao is an unsealed dev server with non-exportable ecdsa-p256 Transit keys', async () => {
    const bao = rootBao(stack!);
    const health = await bao('GET', 'sys/health');
    expect(health.body).toMatchObject({ initialized: true, sealed: false });
    // Recorded for the PR (T02 DoD "OpenBao flags"): the dev server reports in-memory storage,
    // which the control plane's production guard refuses (design §3.8).
    const seal = expectOk(await bao('GET', 'sys/seal-status'), 'seal-status');
    expect(seal.storage_type).toBe('inmem');
    for (const name of TRANSIT_KEYS()) {
      const key = dataOf(expectOk(await bao('GET', `transit/keys/${name}`), name));
      expect(key).toMatchObject({
        type: 'ecdsa-p256',
        exportable: false,
        allow_plaintext_backup: false,
      });
    }
  });
});
