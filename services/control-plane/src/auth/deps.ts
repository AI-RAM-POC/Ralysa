// What the RTS grants and routes need (assembled by serve; tests inject their own).
import type { KeyCustody } from '@ralysa/secrets';
import type { Kysely } from 'kysely';
import type { RejectionAggregator } from '../audit/rejections.js';
import type { AuditWriter } from '../audit/writer.js';
import type { ServeConfig } from '../config/schema.js';
import type { Database } from '../db/types.js';
import { type ClientRegistry, createClientRegistry } from './clients.js';
import type { IdpDirectory } from './directory-port.js';
import { policyVersion } from './policy-version.js';
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
  now?: () => number;
}

export function assembleRtsDeps(
  config: ServeConfig,
  keys: SigningKeys,
  services: RtsServices,
): RtsDeps {
  const clients = createClientRegistry(config);
  return {
    ...services,
    config,
    keys,
    clients,
    verifier: createLocalVerifier({ config, keys, db: services.db, clients }),
    policyVersion: policyVersion(config.access),
  };
}
