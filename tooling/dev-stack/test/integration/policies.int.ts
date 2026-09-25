// SEC-F002-02, -11, -22 policy-boundary harness (part of TC-F-002-26): each entry point and service
// logs in through its own AppRole and gets exactly its §6.5 rights. `serve` can't read the
// migrator or sealer credentials or sign checkpoints; one service can't sign with another's key;
// no non-operator identity can reach key config, export, backup, restore, import or rotate.
import { describe, expect, it } from 'vitest';
import { denyRules, ENTRY_POINT_POLICIES, servicePolicy } from '../../src/bootstrap-vault.ts';
import {
  type BaoRequest,
  baoClient,
  dataOf,
  devStackOrSkip,
  expectOk,
  roleBao,
  rootBao,
} from '../../src/harness/index.ts';
import { CHECKPOINT_KEY, DEV_SERVICES, RTS_SIGNING_KEY, serviceKey } from '../../src/stack.ts';

const stack = await devStackOrSkip();

type Op = 'read' | 'sign' | 'config' | 'export' | 'backup' | 'rotate' | 'restore' | 'import';

async function attempt(bao: BaoRequest, op: Op, target: string): Promise<number> {
  const input = 'cmFseXNh'; // base64("ralysa")
  switch (op) {
    case 'read':
      return (await bao('GET', target)).status;
    case 'sign':
      return (await bao('POST', `transit/sign/${target}/sha2-256`, { input })).status;
    case 'config':
      return (await bao('POST', `transit/keys/${target}/config`, { exportable: true })).status;
    case 'export':
      return (await bao('GET', `transit/export/signing-key/${target}`)).status;
    case 'backup':
      return (await bao('GET', `transit/backup/${target}`)).status;
    case 'rotate':
      return (await bao('POST', `transit/keys/${target}/rotate`, {})).status;
    case 'restore':
      return (await bao('POST', `transit/restore/${target}`, { backup: 'x' })).status;
    case 'import':
      return (await bao('POST', `transit/keys/${target}/import`, { ciphertext: 'x' })).status;
  }
}

const db = (key: string) => `kv/data/ralysa/control-plane/db/${key}`;
const ALLOWED = 200;
const DENIED = 403;

/** [role, op, target, expected status] */
const CASES: [string, Op, string, number][] = [
  ['ralysa-cp-serve', 'read', db('cp_app'), ALLOWED],
  ['ralysa-cp-serve', 'read', db('audit_writer'), ALLOWED],
  ['ralysa-cp-serve', 'read', db('audit_reader'), ALLOWED],
  ['ralysa-cp-serve', 'read', 'kv/data/ralysa/control-plane/audit-hmac', ALLOWED],
  ['ralysa-cp-serve', 'read', db('migrator'), DENIED],
  ['ralysa-cp-serve', 'read', db('audit_migrator'), DENIED],
  ['ralysa-cp-serve', 'read', db('audit_sealer'), DENIED],
  ['ralysa-cp-serve', 'sign', RTS_SIGNING_KEY, ALLOWED],
  ['ralysa-cp-serve', 'sign', CHECKPOINT_KEY, DENIED],
  ['ralysa-cp-serve', 'sign', serviceKey('model-gateway'), DENIED],
  ['ralysa-cp-serve', 'read', `transit/keys/${RTS_SIGNING_KEY}`, ALLOWED],
  ['ralysa-cp-serve', 'read', `transit/keys/${serviceKey('model-gateway')}`, ALLOWED],
  ['ralysa-cp-serve', 'read', `transit/keys/${CHECKPOINT_KEY}`, DENIED],
  ['ralysa-cp-sealer', 'read', db('audit_sealer'), ALLOWED],
  ['ralysa-cp-sealer', 'read', db('cp_app'), DENIED],
  ['ralysa-cp-sealer', 'read', db('migrator'), DENIED],
  ['ralysa-cp-sealer', 'sign', CHECKPOINT_KEY, ALLOWED],
  ['ralysa-cp-sealer', 'sign', RTS_SIGNING_KEY, DENIED],
  ['ralysa-cp-migrate', 'read', db('migrator'), ALLOWED],
  ['ralysa-cp-migrate', 'read', db('audit_writer'), ALLOWED],
  ['ralysa-cp-migrate', 'read', db('audit_migrator'), DENIED],
  ['ralysa-cp-migrate', 'read', db('audit_sealer'), DENIED],
  ['ralysa-cp-migrate', 'sign', RTS_SIGNING_KEY, DENIED],
  ['ralysa-cp-migrate-audit', 'read', db('audit_migrator'), ALLOWED],
  ['ralysa-cp-migrate-audit', 'read', db('audit_writer'), ALLOWED],
  ['ralysa-cp-migrate-audit', 'read', db('migrator'), DENIED],
  ['ralysa-cp-verify', 'read', db('audit_reader'), ALLOWED],
  ['ralysa-cp-verify', 'read', `transit/keys/${CHECKPOINT_KEY}`, ALLOWED],
  ['ralysa-cp-verify', 'sign', CHECKPOINT_KEY, DENIED],
  ['ralysa-cp-verify', 'read', db('audit_writer'), DENIED],
  ['ralysa-svc-model-gateway', 'sign', serviceKey('model-gateway'), ALLOWED],
  ['ralysa-svc-model-gateway', 'sign', serviceKey('agent-host'), DENIED],
  ['ralysa-svc-model-gateway', 'sign', RTS_SIGNING_KEY, DENIED],
  ['ralysa-svc-model-gateway', 'read', db('cp_app'), DENIED],
];

/** Custody paths (SEC-F002-11) that every non-operator identity must be refused. */
const CUSTODY_OPS: Op[] = ['config', 'export', 'backup', 'rotate', 'restore', 'import'];
const ROLES = [...ENTRY_POINT_POLICIES, ...DEV_SERVICES.map(servicePolicy)];

describe.skipIf(stack === undefined)('OpenBao per-entry-point policies (SEC-F002-02, -22)', () => {
  const tokens = new Map<string, Promise<BaoRequest>>();
  const as = (role: string): Promise<BaoRequest> => {
    let bao = tokens.get(role);
    if (bao === undefined) {
      bao = roleBao(stack!, role).then((r) => r.bao);
      tokens.set(role, bao);
    }
    return bao;
  };

  it.each(CASES)('%s %s %s → %i', async (role, op, target, expected) => {
    expect(await attempt(await as(role), op, target)).toBe(expected);
  });

  it.each(ROLES)('%s is refused every custody path on every key', async (role) => {
    const bao = await as(role);
    for (const key of [RTS_SIGNING_KEY, CHECKPOINT_KEY, serviceKey('model-gateway')]) {
      for (const op of CUSTODY_OPS) {
        expect({ key, op, status: await attempt(bao, op, key) }).toEqual({
          key,
          op,
          status: DENIED,
        });
      }
    }
  });

  // Review finding 4 and the reason for T02-3. OpenBao applies only the highest-priority
  // matching pattern. Against the deny `transit/keys/+/config`, the allow `transit/keys/*` loses
  // (same first-wildcard position, and a trailing `*` ranks lower), so the deny wins. A narrower
  // glob like `transit/keys/ralysa-*` has its first wildcard later and outranks the deny, which is
  // why no Ralysa allow rule uses a glob. Both probes use a throwaway key and a harmless config
  // change, so no real key can become exportable.
  it.each([
    ['transit/keys/*', DENIED],
    ['transit/keys/ralysa-*', ALLOWED],
  ])('with the standard denies, a %s allow gets %i on key config', async (glob, expected) => {
    const root = rootBao(stack!);
    const key = 'ralysa-test-glob-probe';
    const policy = `ralysa-test-glob-${expected === DENIED ? 'broad' : 'narrow'}`;
    if ((await root('GET', `transit/keys/${key}`)).status === 404) {
      expectOk(await root('POST', `transit/keys/${key}`, { type: 'ecdsa-p256' }), 'probe key');
    }
    const hcl = [
      `path "${glob}" {\n  capabilities = ["create", "update", "read"]\n}\n`,
      ...denyRules('transit').map((r) => `path "${r.path}" {\n  capabilities = ["deny"]\n}\n`),
    ].join('\n');
    expectOk(await root('PUT', `sys/policies/acl/${policy}`, { policy: hcl }), 'probe policy');
    try {
      const auth = expectOk(
        await root('POST', 'auth/token/create', { policies: [policy], ttl: '2m' }),
        'probe token',
      ).auth as { client_token: string };
      const bao = baoClient(stack!.openbao.addr, auth.client_token);
      // Reads are allowed by both globs, so the token works; only config is decided by the deny.
      expect((await bao('GET', `transit/keys/${key}`)).status).toBe(ALLOWED);
      const config = await bao('POST', `transit/keys/${key}/config`, { min_decryption_version: 1 });
      expect(config.status === 204 ? ALLOWED : config.status).toBe(expected);
    } finally {
      await root('DELETE', `sys/policies/acl/${policy}`);
    }
  });

  it('a single-use secret_id can not log in twice', async () => {
    const root = rootBao(stack!);
    const role = 'ralysa-cp-serve';
    const roleId = dataOf(
      expectOk(await root('GET', `auth/approle/role/${role}/role-id`), 'id'),
    ).role_id;
    const secretId = dataOf(
      expectOk(await root('POST', `auth/approle/role/${role}/secret-id`, {}), 'secret'),
    ).secret_id;
    const anonymous = baoClient(stack!.openbao.addr);
    const body = { role_id: roleId, secret_id: secretId };
    expect((await anonymous('POST', 'auth/approle/login', body)).status).toBe(200);
    expect((await anonymous('POST', 'auth/approle/login', body)).status).not.toBe(200);
  });
});
