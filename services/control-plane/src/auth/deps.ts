// What the RTS grants and routes need (assembled by serve; tests inject their own).
import type { KeyCustody, SecretStore } from '@ralysa/secrets';
import { createInMemorySecretStore } from '@ralysa/secrets';
import type { Kysely } from 'kysely';
import type { RejectionAggregator } from '../audit/rejections.js';
import type { AuditWriter } from '../audit/writer.js';
import type { ServeConfig } from '../config/schema.js';
import type { Database } from '../db/types.js';
import { type Logger, silentLogger } from '../observability/logger.js';
import { type Metrics, noopMetrics } from '../observability/metrics.js';
import { type ClientRegistry, createClientRegistry } from './clients.js';
import type { IdpDirectory } from './directory-port.js';
import type { ExchangeEnv } from './grants/token-exchange.js';
import { type IdentifierHmac, createIdentifierHmac } from './identifier-hmac.js';
import {
  type EntraTokenValidator,
  createEntraTokenValidator,
} from './idp/entra-token-validator.js';
import { type IdpMetadataSource, createIdpMetadataSource } from './idp/metadata.js';
import { policyVersion } from './policy-version.js';
import {
  type SignInFailureAggregator,
  createSignInFailureAggregator,
} from './routes/sign-in-failures.js';
import { type SignInStore, createSignInStore } from './sign-in-store.js';
import { mintAccessToken } from './tokens/mint.js';
import type { SigningKeys } from './tokens/signing-keys.js';
import { type LocalVerifier, createLocalVerifier } from './verify-local.js';

/** What the serve process (or a test) provides; buildApp derives the rest from config. */
export interface RtsServices {
  /** ralysa_cp_app */
  db: Kysely<Database>;
  /** Reads service assertion public keys (transit/keys/ralysa-svc-*). */
  custody: KeyCustody;
  directory: IdpDirectory;
  writer: AuditWriter;
  rejections: RejectionAggregator;
  /** KV: the audit HMAC key (and, through the Graph directory, the IdP client secret). */
  secrets?: SecretStore;
  /** The pinned IdP's discovery document and keys (default: fetched from `idp.issuer`). */
  idpMetadata?: IdpMetadataSource;
  /** Client-reported sign-in failures, aggregated (serve flushes it on a timer). */
  signInFailures?: SignInFailureAggregator;
  metrics?: Metrics;
  logger?: Logger;
  /** Process clock for in-memory caches (tests advance it); timestamps in data use the DB clock. */
  now?: () => number;
}

export interface RtsDeps {
  config: ServeConfig;
  /** ralysa_cp_app */
  db: Kysely<Database>;
  keys: SigningKeys;
  /** Reads service assertion public keys (transit/keys/ralysa-svc-*). */
  custody: KeyCustody;
  directory: IdpDirectory;
  writer: AuditWriter;
  clients: ClientRegistry;
  verifier: LocalVerifier;
  rejections: RejectionAggregator;
  policyVersion: string;
  idpMetadata: IdpMetadataSource;
  validator: EntraTokenValidator;
  signInStore: SignInStore;
  hmac: IdentifierHmac;
  signInFailures: SignInFailureAggregator;
  metrics: Metrics;
  logger: Logger;
  now?: () => number;
}

export function assembleRtsDeps(
  config: ServeConfig,
  keys: SigningKeys,
  services: RtsServices,
): RtsDeps {
  const clients = createClientRegistry(config);
  const logger = services.logger ?? silentLogger;
  const idpMetadata =
    services.idpMetadata ?? createIdpMetadataSource({ issuer: config.idp.issuer });
  const writer = services.writer;
  return {
    ...services,
    config,
    keys,
    clients,
    verifier: createLocalVerifier({ config, keys, db: services.db, clients }),
    policyVersion: policyVersion(config.access),
    idpMetadata,
    validator: createEntraTokenValidator({
      config,
      keys: idpMetadata.keys,
      ...(services.now === undefined ? {} : { now: services.now }),
    }),
    signInStore: createSignInStore(services.db, config.org.id),
    hmac: createIdentifierHmac(
      services.secrets ?? createInMemorySecretStore(),
      config.audit_hmac_path,
    ),
    signInFailures:
      services.signInFailures ??
      createSignInFailureAggregator({
        emit: (events) => {
          void writer.writeOrSpool(config.org.id, events).catch((error: unknown) => {
            logger.warn('sign_in_failure_write_failed', { error: String(error) });
          });
        },
        orgId: config.org.id,
        policyVersion: policyVersion(config.access),
      }),
    metrics: services.metrics ?? noopMetrics,
    logger,
  };
}

/** The sign-in environment of the grants (sign-in.ts, token-exchange.ts). */
export function exchangeEnv(deps: RtsDeps): ExchangeEnv {
  return {
    config: deps.config,
    policyVersion: deps.policyVersion,
    directory: deps.directory,
    store: deps.signInStore,
    writer: deps.writer,
    hmac: deps.hmac,
    mint: (claims) => mintAccessToken(deps.keys, claims),
    metrics: deps.metrics,
    logger: deps.logger,
    validator: deps.validator,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
}
