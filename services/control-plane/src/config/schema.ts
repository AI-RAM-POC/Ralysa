// Per-entry-point configuration (F-002 design §3.8; SEC-F002-02, -12; [AR-9]). Config holds
// identifiers and vault PATHS only: every credential field is a KV path, and a value that isn't
// one fails validation. Each entry point has its own strict schema, so e.g. the migrate job's
// config can't name the sealer's credential and vice versa.
//
// F-002-T05 defines the shared parts and the two migrate entry points; T07 adds serve, sealer
// and audit-verify on the same parts.
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

export type CommonConfig = MigrateConfig | MigrateAuditConfig | SealerConfig | AuditVerifyConfig;
