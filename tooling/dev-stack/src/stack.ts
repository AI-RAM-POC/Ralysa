// Fixed facts about the local dev stack (F-002 design §8.2). deploy/docker/dev/compose.yaml binds
// these ports on 127.0.0.1 only. Dependency-free: the .env generator imports it before install.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root: tooling/dev-stack/src (or dist) → three levels up. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The only folder the .env generator may write into (SEC-F002-29). */
export const DEV_DIR = join(REPO_ROOT, 'deploy', 'docker', 'dev');
export const COMPOSE_FILE = join(DEV_DIR, 'compose.yaml');
export const DEFAULT_ENV_FILE = join(DEV_DIR, '.env');
/** The DBA script from the control plane (F-002-T05): roles, grants, DDL event trigger. */
export const BOOTSTRAP_ROLES_SQL = join(
  REPO_ROOT,
  'services',
  'control-plane',
  'src',
  'db',
  'sql',
  'bootstrap-roles.sql',
);

export const POSTGRES = { host: '127.0.0.1', port: 55432, database: 'ralysa', user: 'postgres' };
export const OPENBAO_ADDR = 'http://127.0.0.1:58200';

/** The variables the generator writes, and so the only credentials the stack has. */
export const ENV_KEYS = ['POSTGRES_PASSWORD', 'BAO_DEV_ROOT_TOKEN_ID'] as const;
export type EnvKey = (typeof ENV_KEYS)[number];

/** Mounts, as the design names them (§3.8 `kv_mount`, `transit_mount` defaults). */
export const KV_MOUNT = 'kv';
export const TRANSIT_MOUNT = 'transit';
/** KV v2 prefix of every control-plane secret: `kv/ralysa/control-plane/...` (§4.1, §6.5). */
export const CP_KV_PREFIX = 'ralysa/control-plane';
/**
 * Written by `bootstrap` (root token) only after OpenBao **and** the Postgres roles are done, so
 * the harness can tell a finished bootstrap from one that stopped half-way. Outside
 * CP_KV_PREFIX: no Ralysa policy can read it. OpenBao dev storage is in-memory, so a restarted
 * stack loses it and asks for a new bootstrap, which it needs anyway.
 */
export const BOOTSTRAP_MARKER = 'ralysa/dev-stack/bootstrapped';
/** A policy the harness checks for as well (the serve entry point's). */
export const PROBE_POLICY = 'ralysa-cp-serve';

/**
 * Database login roles (§4.1) and the KV entry holding each password
 * (`kv/ralysa/control-plane/db/<key>`). `ralysa_audit_owner` is NOLOGIN and has no password;
 * `ralysa_usage_writer` arrives with F-004. Privileges, ownership and memberships are
 * bootstrap-roles.sql's job (F-002-T05).
 */
export const DB_ROLES = [
  { role: 'ralysa_migrator', key: 'migrator' },
  { role: 'ralysa_audit_migrator', key: 'audit_migrator' },
  { role: 'ralysa_cp_app', key: 'cp_app' },
  { role: 'ralysa_audit_writer', key: 'audit_writer' },
  { role: 'ralysa_audit_reader', key: 'audit_reader' },
  { role: 'ralysa_audit_sealer', key: 'audit_sealer' },
] as const;
export type DbRoleKey = (typeof DB_ROLES)[number]['key'];

/** Transit keys (§3.2.4, §3.2.7, §4.7): all ecdsa-p256, non-exportable, no plaintext backup. */
export const RTS_SIGNING_KEY = 'ralysa-rts-signing';
export const CHECKPOINT_KEY = 'ralysa-audit-checkpoint';
/** Services that get a `ralysa-svc-<name>` assertion key and policy in the dev stack. */
export const DEV_SERVICES = ['agent-host', 'mcp-gateway', 'model-gateway', 'workspace-runtime'];
export const serviceKey = (service: string): string => `ralysa-svc-${service}`;
