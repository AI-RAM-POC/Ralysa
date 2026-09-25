// Per-entry-point configuration (F-002 design §3.8; SEC-F002-02, -12; [AR-9]). Config holds
// identifiers and vault PATHS only: every credential field is a KV path, and a value that isn't
// one fails validation. Each entry point has its own strict schema, so e.g. the migrate job's
// config can't name the sealer's credential and vice versa.
//
// Shared parts (T05), migrate (T05), sealer and audit-verify (T06/T16), serve (T07). Checks that
// span fields (a KV path's mount = vault.kv_mount, service audit actions) run after parsing in
// crossFieldIssues(), so the schemas stay plain shapes.
import { serviceMayBeAllowListed } from '@ralysa/protocol/audit';
import { Region } from '@ralysa/protocol/common';
import { z } from 'zod';

/** Unset → production [SEC-F002-12]. */
export const Env = z.enum(['dev', 'test', 'production']).default('production');

/** A KV v2 path under the control-plane prefix. A secret value can't pass this pattern. */
export const KvPath = z
  .string()
  .regex(
    /^[a-z0-9_-]{1,64}\/ralysa\/control-plane\/[a-z0-9_/-]{1,120}$/,
    'must be a <kv mount>/ralysa/control-plane/… path',
  );

export const VaultAuthConfig = z.discriminatedUnion('method', [
  z.strictObject({
    method: z.literal('kubernetes'),
    role: z.string().regex(/^[a-z0-9-]{1,64}$/),
    jwt_path: z.string().default('/var/run/secrets/kubernetes.io/serviceaccount/token'),
  }),
  z.strictObject({
    method: z.literal('approle'),
    role_id: z.string().min(1).max(128),
    /** A file holding the (unwrapped) secret_id, written by the platform, mode 0600. */
    secret_id_path: z.string().min(1),
  }),
  z.strictObject({
    method: z.literal('token'),
    /** The NAME of an environment variable holding the token (dev and test only). */
    token_env: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  }),
]);
export type VaultAuthConfig = z.infer<typeof VaultAuthConfig>;

export const Common = {
  env: Env,
  org: z.strictObject({
    id: z.uuid(),
    name: z.string().min(1).max(200),
    residency: z.enum(['in_country', 'in_region']),
    region: Region,
    deployment_model: z.enum(['dedicated', 'on_prem', 'air_gapped']),
  }),
  vault: z.strictObject({
    addr: z.url(),
    auth: VaultAuthConfig,
    allow_approle: z.boolean().default(false),
    transit_mount: z
      .string()
      .regex(/^[a-z0-9_-]{1,64}$/)
      .default('transit'),
    kv_mount: z
      .string()
      .regex(/^[a-z0-9_-]{1,64}$/)
      .default('kv'),
  }),
  db: z.strictObject({
    host: z.string().min(1).max(255),
    port: z.int().min(1).max(65535),
    database: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
    ssl: z.boolean(),
  }),
};

export const MigrateConfig = z.strictObject({
  ...Common,
  db_credentials: z.strictObject({ migrator: KvPath, audit_writer: KvPath }),
});
export type MigrateConfig = z.infer<typeof MigrateConfig>;

export const MigrateAuditConfig = z.strictObject({
  ...Common,
  db_credentials: z.strictObject({ audit_migrator: KvPath, audit_writer: KvPath }),
});
export type MigrateAuditConfig = z.infer<typeof MigrateAuditConfig>;

/**
 * The sealer process (§4.6, §4.7; SEC-F002-02, -26): the audit_sealer credential only. It records
 * checkpoint-key custody violations through audit.record_custody_violation() (audit/0002), not
 * a writer credential (SEC-F002-34).
 */
export const SealerConfig = z.strictObject({
  ...Common,
  checkpoint_key: z.literal('ralysa-audit-checkpoint'),
  interval_ms: z.int().min(100).max(60_000).default(1000),
  sweep_interval_s: z.int().min(60).max(86_400).default(3600),
  checkpoint_interval_s: z.int().min(1).max(3600).default(60),
  custody_poll_s: z.int().min(1).max(300).default(30),
  db_credentials: z.strictObject({ audit_sealer: KvPath }),
});
export type SealerConfig = z.infer<typeof SealerConfig>;

/** `audit-verify` (§4.7): read-only, the reader credential and the checkpoint key's public keys. */
export const AuditVerifyConfig = z.strictObject({
  ...Common,
  checkpoint_key: z.literal('ralysa-audit-checkpoint'),
  db_credentials: z.strictObject({ audit_reader: KvPath }),
});
export type AuditVerifyConfig = z.infer<typeof AuditVerifyConfig>;

/**
 * The serving process (§3.8): RTS, directory, audit ingest/query, governance feed. Its credentials
 * are cp_app, audit_writer and audit_reader only; a migrator or sealer path fails validation
 * [SEC-F002-02, AR-9].
 */
export const ServeConfig = z.strictObject({
  ...Common,
  public_base_url: z.url(), // = token issuer
  listen: z.strictObject({ host: z.string().min(1), port: z.int().min(0).max(65535) }),
  trust_proxy_cidrs: z.array(z.string().regex(/^[0-9a-fA-F:.]+\/\d{1,3}$/)).default([]),
  signing_key: z.literal('ralysa-rts-signing'),
  idp: z.strictObject({
    kind: z.literal('entra'),
    tenant_id: z.uuid(),
    issuer: z.url(),
    rts_client_id: z.uuid(),
    allowed_public_client_ids: z.array(z.uuid()).min(1),
    signin_scope: z.string().min(1).max(200),
    client_secret_path: KvPath,
    graph_base_url: z.url(),
    graph_timeout_ms: z.int().min(100).max(3000).default(3000),
    require_mfa_claim: z.boolean().optional(),
  }),
  access: z.strictObject({
    access_group_id: z.uuid(),
    admin_group_id: z.uuid(),
    device_code_enabled: z.boolean().default(true),
    loopback_ip_mismatch: z.enum(['deny', 'alert']).default('deny'),
    admin_auth_context: z.string().max(64).optional(),
    phishing_resistant_amr: z.array(z.string().max(32)).default(['fido', 'wia']),
    /** A documented exception id, required to run production with require_mfa_claim=false (Q5). */
    mfa_claim_exception_ref: z.string().min(1).max(100).optional(),
  }),
  tokens: z
    .strictObject({
      access_ttl_s: z.int().min(60).max(3600).default(900),
      service_ttl_s: z.int().min(60).max(900).default(300),
      refresh_idle_s: z.int().default(43_200),
      refresh_absolute_s: z.int().default(604_800),
      key_poll_s: z.int().min(1).max(300).default(30),
      activation_delay_s: z.int().min(0).max(3600).default(120),
      signing_key_pin_version: z.int().min(1).optional(),
    })
    .prefault({}),
  rate_limits: z
    .strictObject({
      /** Per client IP, per minute, on /oauth2/*, /v1/auth/* and /.well-known/* [SEC-F002-16]. */
      per_ip_per_minute: z.int().min(1).default(60),
      /** Per instance, per minute, across those routes. */
      global_per_minute: z.int().min(1).default(1200),
    })
    .prefault({}),
  audit: z
    .strictObject({
      spool_dir: z.string().min(1).default('/var/lib/ralysa/audit-spool'),
      /** false: no persistent volume; loss on restart is accepted (SEC-F002-24). */
      spool_persistent: z.boolean().default(true),
    })
    .prefault({}),
  audit_hmac_path: KvPath,
  db_credentials: z.strictObject({ cp_app: KvPath, audit_writer: KvPath, audit_reader: KvPath }),
  services: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
        client_id: z.string().regex(/^svc:[a-z][a-z0-9-]{1,40}$/),
        transit_key: z.string().regex(/^ralysa-svc-[a-z][a-z0-9-]{1,40}$/),
        audit_actions: z.array(z.string().regex(/^[a-z_]+(\.[a-z_]+){1,3}$/)).min(1),
      }),
    )
    .default([]),
});
export type ServeConfig = z.infer<typeof ServeConfig>;

export type CommonConfig =
  MigrateConfig | MigrateAuditConfig | SealerConfig | AuditVerifyConfig | ServeConfig;

/** Every KV path in a config, with its field name. */
function kvPaths(config: CommonConfig): [string, string][] {
  const paths: [string, string][] = Object.entries(config.db_credentials).map(([k, v]) => [
    `db_credentials.${k}`,
    v,
  ]);
  if ('idp' in config) {
    paths.push(['idp.client_secret_path', config.idp.client_secret_path]);
    paths.push(['audit_hmac_path', config.audit_hmac_path]);
  }
  return paths;
}

/**
 * Checks across fields that a plain schema can't express. Messages name fields, never values.
 *   - every KV path starts with vault.kv_mount (OI-2);
 *   - serve: each service's audit actions may be allow-listed [SEC-F002-03]; service names are
 *     unique and the client id and Transit key follow the name.
 */
export function crossFieldIssues(config: CommonConfig): string[] {
  const issues: string[] = [];
  for (const [field, path] of kvPaths(config)) {
    if (!path.startsWith(`${config.vault.kv_mount}/`)) {
      issues.push(`${field}: must be under vault.kv_mount (${config.vault.kv_mount}/…)`);
    }
  }
  if ('services' in config) {
    const seen = new Set<string>();
    for (const [i, service] of config.services.entries()) {
      for (const action of service.audit_actions) {
        if (!serviceMayBeAllowListed(action)) {
          issues.push(
            `services.${String(i)}.audit_actions: ${action} is reserved for the control plane`,
          );
        }
      }
      if (service.transit_key !== `ralysa-svc-${service.name}`) {
        issues.push(`services.${String(i)}.transit_key: must be ralysa-svc-${service.name}`);
      }
      if (service.client_id !== `svc:${service.name}`) {
        issues.push(`services.${String(i)}.client_id: must be svc:${service.name}`);
      }
      if (seen.has(service.name)) issues.push(`services.${String(i)}.name: duplicate`);
      seen.add(service.name);
    }
  }
  return issues;
}

/** require_mfa_claim defaults to true in production [SEC-F002-06]. */
export function mfaClaimRequired(config: ServeConfig): boolean {
  return config.idp.require_mfa_claim ?? config.env === 'production';
}
