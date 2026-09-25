// OpenBao bootstrap for the dev stack (F-002 design §6.5, §8.2; SEC-F002-02, -11, -22):
// - Transit and KV v2 mounts;
// - Transit keys (RTS signing, audit checkpoint, one assertion key per service), ecdsa-p256 with
//   exportable=false and allow_plaintext_backup=false, read back and checked;
// - random DB role passwords and the audit HMAC key in KV v2 (created once, never printed);
// - one ACL policy per entry point and per service, with the explicit denies;
// - dev AppRole logins bound to those policies, and the Kubernetes-auth role template the real
//   deployments use (one ServiceAccount, namespace and audience per role).
//
// Policy paths are exact: no allow rule uses a glob or `+`. OpenBao applies only the
// highest-priority matching pattern across a token's policies, so an allow glob such as
// `transit/keys/ralysa-svc-*` would outrank the `transit/keys/+/config` deny and could reach
// `…/config`. With exact allows, each deny is the only pattern that matches its paths.
import { randomBytes } from 'node:crypto';
import { type BaoRequest, dataOf, expectOk } from './openbao.ts';
import { randomAlphanumeric } from './env.ts';
import {
  CHECKPOINT_KEY,
  CP_KV_PREFIX,
  DB_ROLES,
  DEV_SERVICES,
  KV_MOUNT,
  RTS_SIGNING_KEY,
  TRANSIT_MOUNT,
  serviceKey,
  type DbRoleKey,
  BOOTSTRAP_MARKER,
} from './stack.ts';

export interface PolicyContext {
  kvMount: string;
  transitMount: string;
  services: string[];
}

export const DEFAULT_POLICY_CONTEXT: PolicyContext = {
  kvMount: KV_MOUNT,
  transitMount: TRANSIT_MOUNT,
  services: DEV_SERVICES,
};

/** One policy per entry point (§6.5 table) plus one per service. */
export const ENTRY_POINT_POLICIES = [
  'ralysa-cp-serve',
  'ralysa-cp-sealer',
  'ralysa-cp-migrate',
  'ralysa-cp-migrate-audit',
  'ralysa-cp-verify',
] as const;
export const OPERATOR_POLICY = 'ralysa-operator';
export const servicePolicy = (service: string): string => `ralysa-svc-${service}`;

type Capability = 'read' | 'create' | 'update' | 'list' | 'deny';
interface Rule {
  path: string;
  capabilities: Capability[];
}

/** SEC-F002-11: never reachable by a non-operator identity; the operator keeps rotate only. */
export function denyRules(transit: string, { allowRotate = false } = {}): Rule[] {
  const paths = [
    `${transit}/keys/+/config`,
    `${transit}/export/*`,
    `${transit}/backup/*`,
    `${transit}/restore`,
    `${transit}/restore/*`,
    `${transit}/keys/+/import*`,
    ...(allowRotate ? [] : [`${transit}/keys/+/rotate`]),
  ];
  return paths.map((path) => ({ path, capabilities: ['deny'] }));
}

const kvRead = (ctx: PolicyContext, key: string): Rule => ({
  path: `${ctx.kvMount}/data/${CP_KV_PREFIX}/${key}`,
  capabilities: ['read'],
});
const dbRead = (ctx: PolicyContext, key: DbRoleKey): Rule => kvRead(ctx, `db/${key}`);
/** Transit sign takes the hash in the path or the body, so both forms are granted. */
const signWith = (ctx: PolicyContext, key: string): Rule[] => [
  { path: `${ctx.transitMount}/sign/${key}`, capabilities: ['update'] },
  { path: `${ctx.transitMount}/sign/${key}/sha2-256`, capabilities: ['update'] },
];
const readKey = (ctx: PolicyContext, key: string): Rule => ({
  path: `${ctx.transitMount}/keys/${key}`,
  capabilities: ['read'],
});

/** The allow rules of every policy (§6.5 "Paths and policies"). */
export function policyRules(ctx: PolicyContext = DEFAULT_POLICY_CONTEXT): Record<string, Rule[]> {
  const t = ctx.transitMount;
  const rules: Record<string, Rule[]> = {
    'ralysa-cp-serve': [
      dbRead(ctx, 'cp_app'),
      dbRead(ctx, 'audit_writer'),
      dbRead(ctx, 'audit_reader'),
      kvRead(ctx, 'idp-client-secret'),
      kvRead(ctx, 'audit-hmac'),
      ...signWith(ctx, RTS_SIGNING_KEY),
      readKey(ctx, RTS_SIGNING_KEY),
      // RTS verifies service client assertions with their public keys (§3.2.7).
      ...ctx.services.map((service) => readKey(ctx, serviceKey(service))),
    ],
    'ralysa-cp-sealer': [
      dbRead(ctx, 'audit_sealer'),
      ...signWith(ctx, CHECKPOINT_KEY),
      readKey(ctx, CHECKPOINT_KEY),
    ],
    'ralysa-cp-migrate': [dbRead(ctx, 'migrator'), dbRead(ctx, 'audit_writer')],
    'ralysa-cp-migrate-audit': [dbRead(ctx, 'audit_migrator'), dbRead(ctx, 'audit_writer')],
    'ralysa-cp-verify': [dbRead(ctx, 'audit_reader'), readKey(ctx, CHECKPOINT_KEY)],
    [OPERATOR_POLICY]: [
      // Key rotation and KV writes by a human operator identity (runbooks, F-002-T13).
      { path: `${t}/keys/+/rotate`, capabilities: ['update'] },
      // §6.5: KV create/update only. No `read` on data, so the operator identity can write a new
      // secret version but never read one back; metadata shows version numbers, not values.
      { path: `${ctx.kvMount}/data/${CP_KV_PREFIX}/*`, capabilities: ['create', 'update'] },
      { path: `${ctx.kvMount}/metadata/${CP_KV_PREFIX}/*`, capabilities: ['read', 'list'] },
    ],
  };
  for (const service of ctx.services) {
    rules[servicePolicy(service)] = signWith(ctx, serviceKey(service));
  }
  return rules;
}

export function renderPolicy(name: string, ctx: PolicyContext = DEFAULT_POLICY_CONTEXT): string {
  const allow = policyRules(ctx)[name];
  if (allow === undefined) throw new Error(`unknown policy ${name}`);
  const deny = denyRules(ctx.transitMount, { allowRotate: name === OPERATOR_POLICY });
  const block = (rule: Rule): string =>
    `path "${rule.path}" {\n  capabilities = [${rule.capabilities.map((c) => `"${c}"`).join(', ')}]\n}\n`;
  return [
    `# ${name}: rendered by tooling/dev-stack (F-002 design §6.5). Exact allow paths only.\n`,
    ...allow.map(block),
    '# Explicit denies (SEC-F002-11).\n',
    ...deny.map(block),
  ].join('\n');
}

export interface KubernetesAuthRole {
  role: string;
  bound_service_account_names: [string];
  bound_service_account_namespaces: [string];
  audience: string;
  token_policies: [string];
  token_ttl: string;
  token_max_ttl: string;
}

/**
 * The Kubernetes-auth role template for real deployments (SEC-F002-22, F-023 renders it): each
 * role binds exactly one ServiceAccount in exactly one namespace, with an audience, so no other
 * pod can log in as that entry point or service.
 */
export function kubernetesAuthRoles(options: {
  namespace: string;
  audience: string;
  services?: string[];
}): KubernetesAuthRole[] {
  const names = [...ENTRY_POINT_POLICIES, ...(options.services ?? DEV_SERVICES).map(servicePolicy)];
  return names.map((name) => ({
    role: name,
    bound_service_account_names: [name],
    bound_service_account_namespaces: [options.namespace],
    audience: options.audience,
    token_policies: [name],
    token_ttl: '15m',
    token_max_ttl: '1h',
  }));
}

/**
 * Dev AppRole settings. Production refuses AppRole unless `vault.auth.allow_approle` and then
 * needs a response-wrapped secret_id with these same bindings (SEC-F002-22, §3.2.7). In dev the
 * source address is the Docker bridge, so the CIDRs are loopback plus the private ranges.
 */
export const DEV_APPROLE = {
  secret_id_num_uses: 1,
  secret_id_ttl: '10m',
  token_ttl: '15m',
  token_max_ttl: '1h',
  secret_id_bound_cidrs: ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
  token_bound_cidrs: ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
};

export const TRANSIT_KEYS = (services: string[] = DEV_SERVICES): string[] => [
  RTS_SIGNING_KEY,
  CHECKPOINT_KEY,
  ...services.map(serviceKey),
];

/**
 * Mounts `path` unless it exists. An existing mount must match the type and every requested
 * option (for KV that is `version: '2'`: the control plane reads versioned KV v2 paths, and a
 * KV v1 mount at the same path would silently serve unversioned secrets).
 */
export async function ensureMount(
  bao: BaoRequest,
  path: string,
  type: string,
  options?: Record<string, string>,
): Promise<void> {
  const mounts = dataOf(expectOk(await bao('GET', 'sys/mounts'), 'list mounts'));
  const existing = mounts[`${path}/`] as
    { type?: string; options?: Record<string, string> | null } | undefined;
  if (existing !== undefined) {
    if (existing.type !== type)
      throw new Error(`mount ${path}/ exists with type ${String(existing.type)}`);
    for (const [key, value] of Object.entries(options ?? {})) {
      const actual = existing.options?.[key];
      if (actual !== value) {
        throw new Error(
          `mount ${path}/ exists with ${key}=${String(actual)}, expected ${value}; remove it or reset the dev stack (down -v)`,
        );
      }
    }
    return;
  }
  expectOk(await bao('POST', `sys/mounts/${path}`, { type, options }), `mount ${path}`);
}

async function ensureTransitKey(bao: BaoRequest, transit: string, name: string): Promise<void> {
  const current = await bao('GET', `${transit}/keys/${name}`);
  if (current.status === 404) {
    expectOk(
      await bao('POST', `${transit}/keys/${name}`, {
        type: 'ecdsa-p256',
        exportable: false,
        allow_plaintext_backup: false,
      }),
      `create transit key ${name}`,
    );
  }
  const key = dataOf(expectOk(await bao('GET', `${transit}/keys/${name}`), `read key ${name}`));
  if (
    key.type !== 'ecdsa-p256' ||
    key.exportable !== false ||
    key.allow_plaintext_backup !== false
  ) {
    throw new Error(
      `transit key ${name} must be ecdsa-p256 with exportable=false and allow_plaintext_backup=false (SEC-F002-11)`,
    );
  }
}

async function ensureKvValue(
  bao: BaoRequest,
  kv: string,
  path: string,
  generate: () => string,
): Promise<boolean> {
  const current = await bao('GET', `${kv}/data/${path}`);
  if (current.status === 200) return false;
  if (current.status !== 404) expectOk(current, `read ${kv}/${path}`);
  expectOk(
    await bao('POST', `${kv}/data/${path}`, { data: { value: generate() } }),
    `write ${kv}/${path}`,
  );
  return true;
}

export interface BootstrapVaultResult {
  keys: string[];
  kvCreated: string[];
  policies: string[];
  appRoles: string[];
}

export async function bootstrapVault(
  bao: BaoRequest,
  ctx: PolicyContext = DEFAULT_POLICY_CONTEXT,
): Promise<BootstrapVaultResult> {
  await ensureMount(bao, ctx.transitMount, 'transit');
  await ensureMount(bao, ctx.kvMount, 'kv', { version: '2' });

  const keys = TRANSIT_KEYS(ctx.services);
  for (const key of keys) await ensureTransitKey(bao, ctx.transitMount, key);

  const kvCreated: string[] = [];
  for (const { key } of DB_ROLES) {
    const path = `${CP_KV_PREFIX}/db/${key}`;
    if (await ensureKvValue(bao, ctx.kvMount, path, () => randomAlphanumeric()))
      kvCreated.push(path);
  }
  // Per-org key for attempted_identifier_hmac [AR-17]; used from F-002-T10.
  const hmacPath = `${CP_KV_PREFIX}/audit-hmac`;
  if (
    await ensureKvValue(bao, ctx.kvMount, hmacPath, () => randomBytes(32).toString('base64url'))
  ) {
    kvCreated.push(hmacPath);
  }

  const policies = Object.keys(policyRules(ctx));
  for (const name of policies) {
    expectOk(
      await bao('PUT', `sys/policies/acl/${name}`, { policy: renderPolicy(name, ctx) }),
      `write policy ${name}`,
    );
  }

  const auths = dataOf(expectOk(await bao('GET', 'sys/auth'), 'list auth methods'));
  if (auths['approle/'] === undefined) {
    expectOk(await bao('POST', 'sys/auth/approle', { type: 'approle' }), 'enable approle');
  }
  const appRoles = policies.filter((name) => name !== OPERATOR_POLICY);
  for (const name of appRoles) {
    expectOk(
      await bao('POST', `auth/approle/role/${name}`, { ...DEV_APPROLE, token_policies: [name] }),
      `write approle ${name}`,
    );
  }
  return { keys, kvCreated, policies, appRoles };
}

/** Reads a DB role password from KV with an operator/root token (bootstrap-db only). */
/** Records a completed bootstrap (see BOOTSTRAP_MARKER). Call after the Postgres roles exist. */
export async function markBootstrapped(
  bao: BaoRequest,
  roles: readonly string[],
  kvMount: string = KV_MOUNT,
): Promise<void> {
  expectOk(
    await bao('POST', `${kvMount}/data/${BOOTSTRAP_MARKER}`, {
      data: { roles: roles.join(','), at: new Date().toISOString() },
    }),
    'write bootstrap marker',
  );
}

/** Whether a completed bootstrap is recorded (see BOOTSTRAP_MARKER). */
export async function isBootstrapped(
  bao: BaoRequest,
  kvMount: string = KV_MOUNT,
): Promise<boolean> {
  const marker = await bao('GET', `${kvMount}/data/${BOOTSTRAP_MARKER}`);
  if (marker.status === 404) return false;
  expectOk(marker, 'read bootstrap marker');
  return true;
}

export async function readDbPassword(
  bao: BaoRequest,
  key: DbRoleKey,
  kvMount: string = KV_MOUNT,
): Promise<string> {
  const body = expectOk(
    await bao('GET', `${kvMount}/data/${CP_KV_PREFIX}/db/${key}`),
    `read db/${key}`,
  );
  const value = dataOf(dataOf(body)).value;
  if (typeof value !== 'string') throw new Error(`db/${key} has no string value`);
  return value;
}

/** Logs in with a fresh single-use secret_id (dev and tests only; needs a root/operator token). */
export async function appRoleLogin(
  root: BaoRequest,
  anonymous: BaoRequest,
  role: string,
): Promise<string> {
  const roleId = dataOf(
    expectOk(await root('GET', `auth/approle/role/${role}/role-id`), 'role-id'),
  ).role_id;
  const secretId = dataOf(
    expectOk(await root('POST', `auth/approle/role/${role}/secret-id`, {}), 'secret-id'),
  ).secret_id;
  const login = expectOk(
    await anonymous('POST', 'auth/approle/login', { role_id: roleId, secret_id: secretId }),
    `approle login ${role}`,
  );
  const auth = login.auth as { client_token?: unknown } | undefined;
  if (typeof auth?.client_token !== 'string') throw new Error(`approle login ${role}: no token`);
  return auth.client_token;
}
