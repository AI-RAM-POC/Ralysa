// The `serve` and `bootstrap-org` entry points (F-002 design §2.1, §3.8; SEC-F002-02, -11, -12).
// serve: its own config schema and OpenBao role; production guards (config and OpenBao storage);
// refuses to start on a signing key that violates custody (TC-F-002-14 part); ensures the
// Organization; polls the signing key; replays the audit spool; serves the app.
import { parseArgs } from 'node:util';
import { CustodyViolationError, type KeyCustody } from '@ralysa/secrets';
import { sql } from 'kysely';
import { buildApp } from './app.js';
import { tokenRejectedEvent } from './audit/events.js';
import { createRejectionAggregator } from './audit/rejections.js';
import { openAuditSpool } from './audit/spool.js';
import { createAuditWriter } from './audit/writer.js';
import { CLEANUP_INTERVAL_MS, runCleanup } from './auth/cleanup.js';
import { revokeDeviceCodeSessions } from './auth/device-code-switch.js';
import { createGraphDirectory } from './auth/idp/graph-directory.js';
import { createIdpMetadataSource } from './auth/idp/metadata.js';
import { createSignInFailureAggregator } from './auth/routes/sign-in-failures.js';
import { policyVersion } from './auth/policy-version.js';
import { createSigningKeys } from './auth/tokens/signing-keys.js';
import { openBaoStorageRefusals, serveProductionRefusals } from './config/guards.js';
import { ConfigError, loadConfigFile } from './config/load.js';
import { ServeConfig } from './config/schema.js';
import { createDb } from './db/kysely.js';
import { createPool } from './db/pools.js';
import type { Database } from './db/types.js';
import type { Logger } from './observability/logger.js';
import { createPinoLogger, loggerFromPino } from './observability/pino.js';
import { ensureOrganization } from './org/bootstrap.js';
import { openVault } from './secrets/vault.js';

export const SPOOL_REPLAY_MS = 30_000;

function loadServeConfig(args: string[]): ServeConfig {
  const { values } = parseArgs({ args, options: { config: { type: 'string' } }, strict: true });
  const path = values.config ?? process.env.RALYSA_CONFIG;
  if (path === undefined) throw new ConfigError('usage: control-plane serve --config <file>');
  return loadConfigFile(ServeConfig, path);
}

/** Startup custody check: a signing key that is exportable or allows plaintext backup stops startup. */
export async function assertSigningKeyCustody(custody: KeyCustody, key: string): Promise<void> {
  try {
    await custody.describe(key);
  } catch (error) {
    if (error instanceof CustodyViolationError) {
      throw new ConfigError('refusing to start', [
        `signing key ${key} violates custody (exportable=${String(error.exportable)}, allow_plaintext_backup=${String(error.allowPlaintextBackup)})`,
      ]);
    }
    throw error;
  }
}

function cpPool(
  config: ServeConfig,
  secrets: ReturnType<typeof openVault>['secrets'],
  entry: string,
) {
  return createPool(
    config.db,
    {
      user: 'ralysa_cp_app',
      password: async () => (await secrets.get(config.db_credentials.cp_app)).value,
    },
    { applicationName: `ralysa-control-plane:${entry}`, max: 10 },
  );
}

export async function serveCommand(args: string[]): Promise<number> {
  const config = loadServeConfig(args);
  // One pino instance for the whole process: Fastify, the key watcher, the spool and start-up
  // lines all go through the same redaction and scrubber (§6.6).
  const pinoLogger = createPinoLogger();
  const logger = loggerFromPino(pinoLogger);
  const refusals = [...serveProductionRefusals(config), ...(await openBaoStorageRefusals(config))];
  if (refusals.length > 0) throw new ConfigError('refusing to start', refusals);
  const { secrets, keys: custody } = openVault(config);
  await assertSigningKeyCustody(custody, config.signing_key);

  const pool = cpPool(config, secrets, 'serve');
  const writerPool = createPool(
    config.db,
    {
      user: 'ralysa_audit_writer',
      password: async () => (await secrets.get(config.db_credentials.audit_writer)).value,
    },
    { applicationName: 'ralysa-control-plane:serve', max: 5 },
  );
  const db = createDb<Database>(pool);
  const spool = await openAuditSpool({
    dir: config.audit.spool_dir,
    persistent: config.audit.spool_persistent,
    logger,
  });
  const writer = createAuditWriter({ db: createDb<Database>(writerPool), spool });
  await ensureOrganization(db, config);
  // Device code off: end every live flow-A session (idempotent; config is authoritative, D-30).
  if (!config.access.device_code_enabled) {
    const revoked = await revokeDeviceCodeSessions({ db, orgId: config.org.id, writer });
    logger.info('device_code_disabled', { revoked_sessions: revoked });
  }
  const keys = createSigningKeys({
    db,
    custody,
    orgId: config.org.id,
    key: config.signing_key,
    timing: {
      activationDelayMs: config.tokens.activation_delay_s * 1000,
      retentionMs: (config.tokens.access_ttl_s + 300) * 1000,
      ...(config.tokens.signing_key_pin_version === undefined
        ? {}
        : { pinVersion: config.tokens.signing_key_pin_version }),
    },
    writer,
    logger,
    staleAfterMs: Math.max(30_000, 2 * config.tokens.key_poll_s * 1000),
  });
  await keys.poll();

  // auth.token_rejected, aggregated per client network and reason (§6.4); the org is config's.
  const rejections = createRejectionAggregator({
    emit: (rejection) =>
      void writer
        .writeOrSpool(config.org.id, [tokenRejectedEvent(rejection)])
        .catch((error: unknown) => {
          logger.warn('token_rejected_write_failed', { error: String(error) });
        }),
  });
  // The pinned tenant (discovery, keys) and Microsoft Graph for sign-in and every refresh (§6.3).
  const idpMetadata = createIdpMetadataSource({ issuer: config.idp.issuer });
  const directory = createGraphDirectory({
    config,
    secrets,
    tokenEndpoint: async () => (await idpMetadata.get()).tokenEndpoint,
  });
  const signInFailures = createSignInFailureAggregator({
    emit: (events) => {
      void writer.writeOrSpool(config.org.id, events).catch((error: unknown) => {
        logger.warn('sign_in_failure_write_failed', { error: String(error) });
      });
    },
    orgId: config.org.id,
    policyVersion: policyVersion(config.access),
  });

  const app = await buildApp({
    config,
    keys,
    rts: {
      db,
      custody,
      directory,
      writer,
      rejections,
      secrets,
      idpMetadata,
      signInFailures,
      logger,
    },
    logger: pinoLogger,
    pingDatabase: async () => {
      await sql`select 1`.execute(db);
      return true;
    },
  });
  const timers = [
    setInterval(() => void keys.poll().catch(() => undefined), config.tokens.key_poll_s * 1000),
    setInterval(
      () =>
        void spool
          .replay((org, events) => writer.write(org, events))
          .catch((error: unknown) => {
            logger.warn('audit_spool_replay_failed', { error: String(error) });
          }),
      SPOOL_REPLAY_MS,
    ),
    setInterval(() => {
      rejections.flush();
      signInFailures.flush();
    }, 5_000),
    setInterval(
      () =>
        void runCleanup({
          db,
          orgId: config.org.id,
          writer,
          policyVersion: policyVersion(config.access),
        }).catch((error: unknown) => {
          logger.warn('session_cleanup_failed', { error: String(error) });
        }),
      CLEANUP_INTERVAL_MS,
    ),
  ];
  await app.listen({ host: config.listen.host, port: config.listen.port });
  logger.info('serve_started', { org_id: config.org.id, port: config.listen.port });
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        resolve();
      });
    }
  });
  for (const timer of timers) clearInterval(timer);
  rejections.flush(true);
  signInFailures.flush(true);
  await app.close();
  await Promise.all([pool.end(), writerPool.end()]);
  logger.info('serve_stopped');
  return 0;
}

/** `bootstrap-org`: create or check the one Organization from the serve config (ADR-0003). */
export async function bootstrapOrgCommand(args: string[], logger: Logger): Promise<number> {
  const config = loadServeConfig(args);
  const refusals = serveProductionRefusals(config);
  if (refusals.length > 0) throw new ConfigError('refusing to start', refusals);
  const { secrets } = openVault(config);
  const pool = cpPool(config, secrets, 'bootstrap-org');
  try {
    const result = await ensureOrganization(createDb<Database>(pool), config);
    logger.info('bootstrap_org', { org_id: config.org.id, ...result });
    return 0;
  } finally {
    await pool.end();
  }
}
