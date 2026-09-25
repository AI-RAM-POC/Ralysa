// Per-entry-point config (§3.8; SEC-F002-02, -12): paths only, one strict schema per entry point,
// production guards, and vault auth material read from the platform, never from config.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commonProductionRefusals } from '../src/config/guards.js';
import { ConfigError, loadConfigFile, parseConfig } from '../src/config/load.js';
import { MigrateAuditConfig, MigrateConfig } from '../src/config/schema.js';
import { vaultAuthFrom } from '../src/secrets/vault.js';

const base = {
  org: {
    id: '0192a0c0-0000-7000-8000-00000000d0e1',
    name: 'Org',
    residency: 'in_country',
    region: 'qa-doha',
    deployment_model: 'on_prem',
  },
  vault: {
    addr: 'https://bao.internal:8200',
    auth: { method: 'kubernetes', role: 'ralysa-cp-migrate' },
  },
  db: { host: 'db', port: 5432, database: 'ralysa', ssl: true },
};
const migrate = {
  ...base,
  db_credentials: {
    migrator: 'kv/ralysa/control-plane/db/migrator',
    audit_writer: 'kv/ralysa/control-plane/db/audit_writer',
  },
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('config schemas', () => {
  it('accepts a migrate config and defaults env to production [SEC-F002-12]', () => {
    const config = parseConfig(MigrateConfig, migrate);
    expect(config.env).toBe('production');
    expect(config.vault).toMatchObject({
      allow_approle: false,
      transit_mount: 'transit',
      kv_mount: 'kv',
    });
  });

  it('refuses a secret value where a vault path belongs', () => {
    for (const value of [
      'S3cr3tPassw0rd!',
      'kv/ralysa/other/db/migrator',
      'vault:v1:abc',
      'kv/ralysa/control-plane/../x',
    ]) {
      expect(() =>
        parseConfig(MigrateConfig, {
          ...migrate,
          db_credentials: { ...migrate.db_credentials, migrator: value },
        }),
      ).toThrow(ConfigError);
    }
  });

  it("each migrate job's config names only its own credentials [SEC-F002-02, AR-9]", () => {
    expect(() =>
      parseConfig(MigrateConfig, {
        ...migrate,
        db_credentials: {
          ...migrate.db_credentials,
          audit_sealer: 'kv/ralysa/control-plane/db/audit_sealer',
        },
      }),
    ).toThrow(/Unrecognized key/);
    expect(() => parseConfig(MigrateAuditConfig, migrate)).toThrow(ConfigError);
    expect(
      parseConfig(MigrateAuditConfig, {
        ...base,
        db_credentials: {
          audit_migrator: 'kv/ralysa/control-plane/db/audit_migrator',
          audit_writer: 'kv/ralysa/control-plane/db/audit_writer',
        },
      }).db_credentials,
    ).toHaveProperty('audit_migrator');
  });

  it('refuses unknown keys anywhere, e.g. a password next to the db settings', () => {
    expect(() =>
      parseConfig(MigrateConfig, { ...migrate, db: { ...migrate.db, password: 'x' } }),
    ).toThrow(/Unrecognized key/);
  });

  it('a token auth config names an environment variable, not a token', () => {
    const ok = parseConfig(MigrateConfig, {
      ...migrate,
      env: 'dev',
      vault: { ...migrate.vault, auth: { method: 'token', token_env: 'BAO_DEV_ROOT_TOKEN_ID' } },
    });
    expect(ok.vault.auth).toEqual({ method: 'token', token_env: 'BAO_DEV_ROOT_TOKEN_ID' });
    expect(() =>
      parseConfig(MigrateConfig, {
        ...migrate,
        vault: { ...migrate.vault, auth: { method: 'token', token: 'hvs.x' } },
      }),
    ).toThrow(ConfigError);
  });

  it('validation errors name the field, never the value', () => {
    try {
      parseConfig(MigrateConfig, {
        ...migrate,
        db_credentials: { ...migrate.db_credentials, migrator: 'Sup3rS3cret' },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('db_credentials.migrator');
      expect((error as Error).message).not.toContain('Sup3rS3cret');
    }
  });

  it('loads YAML from a file and reports an unreadable one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ralysa-config-'));
    dirs.push(dir);
    const path = join(dir, 'migrate.yaml');
    writeFileSync(
      path,
      `org: {id: ${base.org.id}, name: Org, residency: in_country, region: qa-doha, deployment_model: on_prem}
vault: {addr: 'https://bao:8200', auth: {method: kubernetes, role: ralysa-cp-migrate}}
db: {host: db, port: 5432, database: ralysa, ssl: true}
db_credentials: {migrator: kv/ralysa/control-plane/db/migrator, audit_writer: kv/ralysa/control-plane/db/audit_writer}
`,
    );
    expect(loadConfigFile(MigrateConfig, path).db.port).toBe(5432);
    expect(() => loadConfigFile(MigrateConfig, join(dir, 'missing.yaml'))).toThrow(
      /cannot read config/,
    );
  });
});

describe('production guards (SEC-F002-12)', () => {
  const production = parseConfig(MigrateConfig, migrate);

  it('a hardened production config passes', () => {
    expect(commonProductionRefusals(production)).toEqual([]);
  });

  it.each([
    [
      'token auth',
      { vault: { ...production.vault, auth: { method: 'token', token_env: 'T' } } },
      /token auth/,
    ],
    [
      'AppRole without allow_approle',
      {
        vault: {
          ...production.vault,
          auth: { method: 'approle', role_id: 'r', secret_id_path: '/s' },
        },
      },
      /allow_approle/,
    ],
    ['http vault', { vault: { ...production.vault, addr: 'http://bao:8200' } }, /https/],
    ['db.ssl=false', { db: { ...production.db, ssl: false } }, /db\.ssl/],
  ] as const)('refuses %s', (_name, change, pattern) => {
    const refusals = commonProductionRefusals({ ...production, ...change });
    expect(refusals.join('\n')).toMatch(pattern);
  });

  it('the same settings are allowed in dev', () => {
    expect(
      commonProductionRefusals({
        ...production,
        env: 'dev',
        db: { ...production.db, ssl: false },
        vault: {
          ...production.vault,
          addr: 'http://127.0.0.1:58200',
          auth: { method: 'token', token_env: 'T' },
        },
      }),
    ).toEqual([]);
  });
});

describe('vault auth from config', () => {
  it('reads the ServiceAccount token and the secret_id from files at login time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ralysa-vault-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'jwt'), 'sa-jwt\n');
    writeFileSync(join(dir, 'secret-id'), 'sid\n');
    const k8s = vaultAuthFrom(
      parseConfig(MigrateConfig, {
        ...migrate,
        vault: {
          ...migrate.vault,
          auth: { method: 'kubernetes', role: 'r', jwt_path: join(dir, 'jwt') },
        },
      }),
    );
    expect(k8s.method === 'kubernetes' && (await k8s.jwt())).toBe('sa-jwt');
    const approle = vaultAuthFrom(
      parseConfig(MigrateConfig, {
        ...migrate,
        vault: {
          ...migrate.vault,
          auth: { method: 'approle', role_id: 'rid', secret_id_path: join(dir, 'secret-id') },
        },
      }),
    );
    expect(approle.method === 'approle' && (await approle.secretId())).toBe('sid');
  });

  it('token auth reads the named environment variable and fails clearly without it', () => {
    const config = parseConfig(MigrateConfig, {
      ...migrate,
      env: 'dev',
      vault: { ...migrate.vault, auth: { method: 'token', token_env: 'RALYSA_TEST_TOKEN' } },
    });
    expect(vaultAuthFrom(config, { RALYSA_TEST_TOKEN: 't' })).toEqual({
      method: 'token',
      token: 't',
    });
    expect(() => vaultAuthFrom(config, {})).toThrow(/RALYSA_TEST_TOKEN is not set/);
  });
});
