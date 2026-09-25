// Serve config (TC-F-002-36) and production guards (TC-F-002-34), env overrides, cross-field
// checks (OI-2, SEC-F002-03).
import { describe, expect, it } from 'vitest';
import { openBaoStorageRefusals, serveProductionRefusals } from '../src/config/guards.js';
import { ConfigError, applyEnvOverrides, parseConfig } from '../src/config/load.js';
import { SealerConfig, ServeConfig } from '../src/config/schema.js';
import { serveConfig, serveConfigInput } from './fixtures/serve-config.js';

const kv = (key: string) => `kv/ralysa/control-plane/${key}`;

describe('serve config (TC-F-002-36; SEC-F002-02)', () => {
  it('accepts the fixture; env defaults to production and MFA claim is required there', () => {
    const config = serveConfig();
    expect(config.env).toBe('production');
    expect(config.tokens).toMatchObject({
      access_ttl_s: 900,
      key_poll_s: 30,
      activation_delay_s: 120,
    });
    expect(config.audit.spool_persistent).toBe(true);
  });

  it.each(['migrator', 'audit_migrator', 'audit_sealer'])(
    'refuses a %s credential in serve',
    (key) => {
      const input = serveConfigInput();
      expect(() =>
        parseConfig(ServeConfig, {
          ...input,
          db_credentials: { ...(input.db_credentials as object), [key]: kv(`db/${key}`) },
        }),
      ).toThrow(/Unrecognized key/);
    },
  );

  it('the sealer config accepts only its own credential', () => {
    const common = serveConfigInput();
    const sealer = {
      org: common.org,
      vault: common.vault,
      db: common.db,
      checkpoint_key: 'ralysa-audit-checkpoint',
    };
    expect(
      parseConfig(SealerConfig, {
        ...sealer,
        db_credentials: { audit_sealer: kv('db/audit_sealer') },
      }),
    ).toBeDefined();
    expect(() =>
      parseConfig(SealerConfig, {
        ...sealer,
        db_credentials: { audit_sealer: kv('db/audit_sealer'), cp_app: kv('db/cp_app') },
      }),
    ).toThrow(ConfigError);
  });

  it.each([
    [
      'a secret value for the IdP client secret path',
      { idp: { ...(serveConfigInput().idp as object), client_secret_path: 'S3cr3t~value' } },
    ],
    [
      'an idp.client_secret key',
      { idp: { ...(serveConfigInput().idp as object), client_secret: 'x' } },
    ],
    ['a secret value for audit_hmac_path', { audit_hmac_path: 'c2VjcmV0LWhtYWMta2V5' }],
    [
      'a group name instead of an object id',
      { access: { access_group_id: 'Ralysa Users', admin_group_id: 'x' } },
    ],
  ])('refuses %s', (_name, change) => {
    expect(() => parseConfig(ServeConfig, serveConfigInput(change))).toThrow(ConfigError);
  });

  it('every KV path must sit under vault.kv_mount (OI-2)', () => {
    const input = serveConfigInput();
    expect(() =>
      parseConfig(ServeConfig, {
        ...input,
        vault: { ...(input.vault as object), kv_mount: 'secret' },
      }),
    ).toThrow(/must be under vault.kv_mount/);
  });

  it('a service may not be allow-listed for reserved actions beyond the two exceptions (SEC-F002-03)', () => {
    const service = {
      name: 'model-gateway',
      client_id: 'svc:model-gateway',
      transit_key: 'ralysa-svc-model-gateway',
    };
    expect(() =>
      parseConfig(
        ServeConfig,
        serveConfigInput({ services: [{ ...service, audit_actions: ['auth.sign_in'] }] }),
      ),
    ).toThrow(/reserved for the control plane/);
    expect(() =>
      parseConfig(
        ServeConfig,
        serveConfigInput({
          services: [{ ...service, transit_key: 'ralysa-svc-other', audit_actions: ['x.y'] }],
        }),
      ),
    ).toThrow(/transit_key/);
  });

  it('validation errors name fields, never values', () => {
    try {
      parseConfig(ServeConfig, serveConfigInput({ audit_hmac_path: 'Sup3r-S3cret-Val' }));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('audit_hmac_path');
      expect((error as Error).message).not.toContain('Sup3r-S3cret-Val');
    }
  });
});

describe('env overrides', () => {
  it('sets nested values, parsing JSON scalars', () => {
    const merged = applyEnvOverrides(serveConfigInput(), {
      RALYSA_CFG__DB__HOST: 'db.internal',
      RALYSA_CFG__LISTEN__PORT: '8443',
      RALYSA_CFG__ACCESS__DEVICE_CODE_ENABLED: 'false',
      OTHER: 'ignored',
    });
    const config = parseConfig(ServeConfig, merged);
    expect(config.db.host).toBe('db.internal');
    expect(config.listen.port).toBe(8443);
    expect(config.access.device_code_enabled).toBe(false);
  });

  it('an override is still validated: it cannot inject a credential', () => {
    const merged = applyEnvOverrides(serveConfigInput(), { RALYSA_CFG__DB__PASSWORD: 'x' });
    expect(() => parseConfig(ServeConfig, merged)).toThrow(/Unrecognized key/);
  });

  it('refuses malformed override names', () => {
    expect(() => applyEnvOverrides({}, { 'RALYSA_CFG__DB__HO-ST': 'x' })).toThrow(ConfigError);
  });
});

describe('production guards (TC-F-002-34; SEC-F002-12)', () => {
  it('the hardened fixture passes', () => {
    expect(serveProductionRefusals(serveConfig())).toEqual([]);
  });

  const idp = serveConfigInput().idp as Record<string, unknown>;
  it.each([
    [
      'vault token auth',
      { vault: { addr: 'https://bao:8200', auth: { method: 'token', token_env: 'T' } } },
      /token auth/,
    ],
    [
      'AppRole without the opt-in',
      {
        vault: {
          addr: 'https://bao:8200',
          auth: { method: 'approle', role_id: 'r', secret_id_path: '/s' },
        },
      },
      /allow_approle/,
    ],
    [
      'http:// vault',
      { vault: { addr: 'http://bao:8200', auth: { method: 'kubernetes', role: 'r' } } },
      /vault.addr/,
    ],
    ['http:// public_base_url', { public_base_url: 'http://ralysa.example.qa' }, /public_base_url/],
    ['db.ssl=false', { db: { host: 'db', port: 5432, database: 'ralysa', ssl: false } }, /db.ssl/],
    ['a 0.0.0.0/0 proxy', { trust_proxy_cidrs: ['10.0.0.0/8', '0.0.0.0/0'] }, /trust_proxy_cidrs/],
    ['a ::/0 proxy', { trust_proxy_cidrs: ['::/0'] }, /trust_proxy_cidrs/],
    [
      'a non-Entra issuer',
      { idp: { ...idp, issuer: 'https://idp.example.com/v2.0' } },
      /idp.issuer/,
    ],
    [
      'an http:// Entra-looking issuer',
      { idp: { ...idp, issuer: `http://login.microsoftonline.com/${String(idp.tenant_id)}/v2.0` } },
      /idp.issuer/,
    ],
    [
      'another tenant',
      {
        idp: {
          ...idp,
          issuer: 'https://login.microsoftonline.com/00000000-0000-4000-8000-000000000000/v2.0',
        },
      },
      /idp.issuer/,
    ],
    [
      'a non-Graph base',
      { idp: { ...idp, graph_base_url: 'https://graph.example.com' } },
      /graph_base_url/,
    ],
    [
      'MFA claim off without an exception',
      { idp: { ...idp, require_mfa_claim: false } },
      /mfa_claim_exception_ref/,
    ],
  ])('refuses %s', (_name, change, pattern) => {
    expect(serveProductionRefusals(serveConfig(change)).join('\n')).toMatch(pattern);
  });

  it('MFA claim off is allowed with a documented exception', () => {
    const config = serveConfig({
      idp: { ...idp, require_mfa_claim: false },
      access: { ...(serveConfigInput().access as object), mfa_claim_exception_ref: 'EXC-2026-007' },
    });
    expect(serveProductionRefusals(config)).toEqual([]);
  });

  it('an unset env behaves as production; dev skips the guards', () => {
    expect(serveProductionRefusals(serveConfig({ public_base_url: 'http://x.test' }))).not.toEqual(
      [],
    );
    expect(
      serveProductionRefusals(serveConfig({ env: 'dev', public_base_url: 'http://x.test' })),
    ).toEqual([]);
  });

  it.each([
    [{ storage_type: 'inmem', sealed: false }, /in-memory/],
    [{ storage_type: 'raft', sealed: true }, /sealed/],
  ])('OpenBao seal-status %o is refused', async (body, pattern) => {
    const refusals = await openBaoStorageRefusals(serveConfig(), () =>
      Promise.resolve({ status: 200, json: () => Promise.resolve(body) }),
    );
    expect(refusals.join('\n')).toMatch(pattern);
  });

  it('an unreachable OpenBao is refused; a raft-backed unsealed one passes', async () => {
    await expect(
      openBaoStorageRefusals(serveConfig(), () => Promise.reject(new Error('down'))),
    ).resolves.toEqual(['OpenBao seal-status is not reachable']);
    await expect(
      openBaoStorageRefusals(serveConfig(), () =>
        Promise.resolve({
          status: 200,
          json: () => Promise.resolve({ storage_type: 'raft', sealed: false }),
        }),
      ),
    ).resolves.toEqual([]);
  });
});
