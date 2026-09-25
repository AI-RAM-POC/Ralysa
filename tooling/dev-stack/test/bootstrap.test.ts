// Hermetic checks of the bootstrap: SCRAM verifiers (RFC 7677 vector), the psql roles script, the
// rendered OpenBao policies and the Kubernetes-auth role template (SEC-F002-02, -11, -22, -29).
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { passwordVariable, rolesScript, verifiersFor } from '../src/bootstrap-db.ts';
import {
  DEFAULT_POLICY_CONTEXT,
  ENTRY_POINT_POLICIES,
  OPERATOR_POLICY,
  denyRules,
  ensureMount,
  isBootstrapped,
  markBootstrapped,
  kubernetesAuthRoles,
  policyRules,
  renderPolicy,
  servicePolicy,
} from '../src/bootstrap-vault.ts';
import type { BaoRequest } from '../src/openbao.ts';
import { scramKeys, scramVerifier } from '../src/scram.ts';
import { DB_ROLES, DEV_SERVICES } from '../src/stack.ts';

describe('SCRAM-SHA-256 verifiers', () => {
  // RFC 7677 §3: user "user", password "pencil".
  const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
  const authMessage = [
    'n=user,r=rOprNGfwEbeRWgbNEkqO',
    'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096',
    'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0',
  ].join(',');

  it('derives the RFC 7677 server signature and client proof', () => {
    const k = scramKeys('pencil', salt);
    const serverSignature = createHmac('sha256', k.serverKey).update(authMessage).digest('base64');
    expect(serverSignature).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
    const clientSignature = createHmac('sha256', k.storedKey).update(authMessage).digest();
    const proof = Buffer.from(k.clientKey.map((byte, i) => byte ^ (clientSignature[i] ?? 0)));
    expect(proof.toString('base64')).toBe('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=');
  });

  it('formats the verifier the way Postgres stores it, with a fresh salt each time', () => {
    const verifier = scramVerifier('pencil');
    expect(verifier).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
    );
    expect(scramVerifier('pencil')).not.toBe(verifier);
  });
});

describe('roles script (SEC-F002-29)', () => {
  const passwords = Object.fromEntries(
    DB_ROLES.map(({ key }) => [key, `pw${key}ABCDEFGH12345678`]),
  );
  const script = rolesScript(verifiersFor(passwords));

  it('never contains a plaintext password, only SCRAM verifiers in psql variables', () => {
    for (const password of Object.values(passwords)) expect(script).not.toContain(password);
    for (const { role } of DB_ROLES) {
      expect(script).toMatch(new RegExp(`\\\\set ${passwordVariable(role)} 'SCRAM-SHA-256\\$`));
      expect(script).toContain(`PASSWORD :'${passwordVariable(role)}'`);
    }
  });

  it('stops on the first error and checks UTF-8 before creating anything', () => {
    expect(script.startsWith('\\set ON_ERROR_STOP on')).toBe(true);
    expect(script.indexOf("server_encoding') <> 'UTF8'")).toBeLessThan(
      script.indexOf('CREATE ROLE'),
    );
  });

  it('gives no role an elevated attribute', () => {
    for (const { role } of DB_ROLES) {
      expect(script).toContain(
        `ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
    }
    expect(script).not.toMatch(/\b(?<!NO)(SUPERUSER|BYPASSRLS|CREATEROLE)\b/);
  });

  it('refuses a missing password or a verifier that could break out of the psql literal', () => {
    expect(() => verifiersFor({})).toThrow(/no password/);
    const bad = Object.fromEntries(DB_ROLES.map(({ role }) => [role, "SCRAM-SHA-256$x'; DROP"]));
    expect(() => rolesScript(bad)).toThrow(/unexpected character/);
  });
});

describe('OpenBao policies (§6.5; SEC-F002-02, -11)', () => {
  const rules = policyRules();
  const paths = (name: string) => (rules[name] ?? []).map((r) => r.path);

  it('has one policy per entry point, one per service and the operator', () => {
    expect(Object.keys(rules).sort()).toEqual(
      [...ENTRY_POINT_POLICIES, OPERATOR_POLICY, ...DEV_SERVICES.map(servicePolicy)].sort(),
    );
  });

  it('serve can not read the migrator or sealer credentials or sign checkpoints', () => {
    const serve = paths('ralysa-cp-serve');
    expect(serve).toContain('kv/data/ralysa/control-plane/db/cp_app');
    for (const forbidden of ['db/migrator', 'db/audit_migrator', 'db/audit_sealer']) {
      expect(serve.some((p) => p.endsWith(forbidden))).toBe(false);
    }
    expect(serve.some((p) => p.includes('ralysa-audit-checkpoint'))).toBe(false);
  });

  it('only the migrate jobs read the migrator credentials, only the sealer reads its own', () => {
    const readers = (suffix: string) =>
      Object.keys(rules).filter((name) => paths(name).some((p) => p.endsWith(suffix)));
    expect(readers('db/migrator')).toEqual(['ralysa-cp-migrate']);
    expect(readers('db/audit_migrator')).toEqual(['ralysa-cp-migrate-audit']);
    expect(readers('db/audit_sealer')).toEqual(['ralysa-cp-sealer']);
  });

  it('the operator writes KV secrets but can not read them back (§6.5)', () => {
    const kvData = (rules[OPERATOR_POLICY] ?? []).filter((r) => r.path.startsWith('kv/data/'));
    expect(kvData).toEqual([
      { path: 'kv/data/ralysa/control-plane/*', capabilities: ['create', 'update'] },
    ]);
    for (const rule of rules[OPERATOR_POLICY] ?? []) {
      if (rule.path.startsWith('kv/data/')) expect(rule.capabilities).not.toContain('read');
    }
  });

  it('a service policy signs only with its own key', () => {
    for (const service of DEV_SERVICES) {
      expect(paths(servicePolicy(service))).toEqual([
        `transit/sign/ralysa-svc-${service}`,
        `transit/sign/ralysa-svc-${service}/sha2-256`,
      ]);
    }
  });

  it('no non-operator allow rule uses a glob or +, so no allow outranks a deny', () => {
    for (const name of Object.keys(rules).filter((n) => n !== OPERATOR_POLICY)) {
      for (const path of paths(name)) expect(path).not.toMatch(/[*+]/);
    }
  });

  it('no allow pattern of any policy, the operator included, matches a denied custody path', () => {
    // OpenBao glob semantics: `+` is exactly one path segment, a trailing `*` any suffix. An allow
    // that matched one of these could outrank the explicit deny (see policies.int.ts, T02-3).
    const segment = '[^/]+';
    const matches = (pattern: string, path: string): boolean => {
      const body = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      const re = body
        .split('+')
        .map((part) => part.replace(/[.*?^${}()|[\]\\]/g, '\\$&'))
        .join(segment);
      return new RegExp(`^${re}${pattern.endsWith('*') ? '.*' : ''}$`).test(path);
    };
    expect(matches('transit/keys/+/rotate', 'transit/keys/x/rotate')).toBe(true);
    expect(matches('transit/keys/*', 'transit/keys/x/config')).toBe(true);
    const deniedSamples = [
      'transit/keys/x/config',
      'transit/keys/ralysa-rts-signing/config',
      'transit/export/signing-key/x',
      'transit/export/signing-key/ralysa-rts-signing/1',
      'transit/backup/x',
      'transit/restore',
      'transit/restore/x',
      'transit/keys/x/import',
      'transit/keys/x/import_version',
    ];
    for (const [name, allow] of Object.entries(rules)) {
      for (const rule of allow) {
        for (const path of deniedSamples) {
          expect({ name, pattern: rule.path, path, matches: matches(rule.path, path) }).toEqual({
            name,
            pattern: rule.path,
            path,
            matches: false,
          });
        }
      }
    }
  });

  it('every policy carries the explicit custody denies; only the operator may rotate', () => {
    for (const name of Object.keys(rules)) {
      const text = renderPolicy(name);
      for (const deny of denyRules('transit', { allowRotate: true })) {
        expect(text).toContain(`path "${deny.path}" {\n  capabilities = ["deny"]`);
      }
      const rotateDenied = text.includes(
        'path "transit/keys/+/rotate" {\n  capabilities = ["deny"]',
      );
      expect(rotateDenied).toBe(name !== OPERATOR_POLICY);
    }
  });

  it('renders custom mounts', () => {
    const text = renderPolicy('ralysa-cp-verify', {
      ...DEFAULT_POLICY_CONTEXT,
      kvMount: 'secret',
      transitMount: 'keys',
    });
    expect(text).toContain('path "secret/data/ralysa/control-plane/db/audit_reader"');
    expect(text).toContain('path "keys/export/*"');
  });
});

describe('Kubernetes-auth role template (SEC-F002-22)', () => {
  const roles = kubernetesAuthRoles({ namespace: 'ralysa', audience: 'openbao' });

  it('binds exactly one ServiceAccount, one namespace and an audience per role', () => {
    expect(roles.map((r) => r.role)).toEqual([
      ...ENTRY_POINT_POLICIES,
      ...DEV_SERVICES.map(servicePolicy),
    ]);
    for (const role of roles) {
      expect(role.bound_service_account_names).toEqual([role.role]);
      expect(role.bound_service_account_namespaces).toEqual(['ralysa']);
      expect(role.audience).toBe('openbao');
      expect(role.token_policies).toEqual([role.role]);
    }
  });
});

describe('ensureMount', () => {
  const fakeBao = (mounts: Record<string, unknown>) => {
    const calls: [string, string, unknown][] = [];
    const bao: BaoRequest = (method, path, body) => {
      calls.push([method, path, body]);
      return Promise.resolve(
        method === 'GET'
          ? { status: 200, body: { data: mounts } }
          : { status: 204, body: undefined },
      );
    };
    return { bao, calls };
  };

  it('mounts KV v2 when absent', async () => {
    const { bao, calls } = fakeBao({});
    await ensureMount(bao, 'kv', 'kv', { version: '2' });
    expect(calls[1]).toEqual(['POST', 'sys/mounts/kv', { type: 'kv', options: { version: '2' } }]);
  });

  it('accepts an existing KV v2 mount without changing it', async () => {
    const { bao, calls } = fakeBao({ 'kv/': { type: 'kv', options: { version: '2' } } });
    await ensureMount(bao, 'kv', 'kv', { version: '2' });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['KV v1', { type: 'kv', options: { version: '1' } }],
    ['KV with no version option', { type: 'kv', options: null }],
  ])('refuses an existing %s mount', async (_name, mount) => {
    const { bao } = fakeBao({ 'kv/': mount });
    await expect(ensureMount(bao, 'kv', 'kv', { version: '2' })).rejects.toThrow(/expected 2/);
  });

  it('refuses an existing mount of another type', async () => {
    const { bao } = fakeBao({ 'kv/': { type: 'transit' } });
    await expect(ensureMount(bao, 'kv', 'kv', { version: '2' })).rejects.toThrow(/type transit/);
  });
});

describe('bootstrap completion marker', () => {
  it('is written under the dev-stack prefix, outside every Ralysa policy', async () => {
    const writes: [string, unknown][] = [];
    const bao: BaoRequest = (_method, path, body) => {
      writes.push([path, body]);
      return Promise.resolve({ status: 200, body: {} });
    };
    await markBootstrapped(bao, ['ralysa_cp_app']);
    expect(writes[0]?.[0]).toBe('kv/data/ralysa/dev-stack/bootstrapped');
    for (const rules of Object.values(policyRules())) {
      for (const rule of rules) expect(rule.path).not.toContain('dev-stack');
    }
  });

  it.each([
    [200, true],
    [404, false],
  ])('isBootstrapped with status %i is %s', async (status, expected) => {
    const bao: BaoRequest = () => Promise.resolve({ status, body: {} });
    expect(await isBootstrapped(bao)).toBe(expected);
  });
});
