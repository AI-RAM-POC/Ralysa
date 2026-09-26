// The IdP client-secret watcher (F-002 design §5.7, §6.5; AC-10; SEC-F002-10).
//
// RTS authenticates to Entra with a client secret kept in OpenBao KV v2
// (`idp.client_secret_path`). Two consumers use it: the Graph directory (app-only token) and the
// flow-B OIDC relying party (code redemption). This module holds the value both of them use:
//
// - It is read once, then kept current by a poll every `idp.client_secret_poll_s` (60 s). A poll
//   that finds a NEWER KV version adopts it; an older or equal one changes nothing, and a failed
//   poll keeps the value in hand (OpenBao down must not break sign-in while the secret is valid).
// - `invalid_client` at the IdP: the caller asks for a re-read at once (single flight) and retries
//   ONCE, and only if the store now holds a different version than the failed call used. A retry
//   with the same value can't succeed, so it isn't made. That keeps a rotation from failing
//   requests on a replica whose next poll hasn't come yet (the operator removes the old secret at
//   the IdP after the new version was observed).
// - Every version this process adopts is logged (`idp_client_secret_observed`, per replica: the
//   runbook's "every replica reports the new version") and recorded as
//   `secret.rotated kind=idp_client_secret phase=observed` ONCE PER VERSION across replicas and
//   restarts: the event id is derived from the org, the path and the version, so a second replica's
//   write is a `duplicate`. A write that fails outright is retried on the next poll.
//
// The value never leaves this module except to the two callers; it is never logged, and the
// event carries only a hash of the path and the version number.
//
// The design's module list also names "DB credential loading per entry point" here: that is done by
// the pools, which read each role's password from KV at connect (db/pools.ts), so nothing is added.
import { createHash } from 'node:crypto';
import type { SecretStore, SecretValue } from '@ralysa/secrets';
import { derivedEventId, systemEvent } from '../audit/events.js';
import type { AuditWriter } from '../audit/writer.js';
import { type Logger, silentLogger } from '../observability/logger.js';
import { type Metrics, noopMetrics } from '../observability/metrics.js';

export const IDP_CLIENT_SECRET_POLL_S = 60;

export interface IdpClientSecret {
  /** The value to authenticate with, and its KV version. Read on first use, then from memory. */
  current(): Promise<SecretValue>;
  /**
   * After the IdP refused the secret of version `used` with `invalid_client`: re-reads the store at
   * once (one read shared by concurrent callers). Resolves to the newer value to retry with, or to
   * undefined when the store still holds `used` (no retry: it would fail the same way).
   */
  refreshAfterInvalidClient(used: number): Promise<SecretValue | undefined>;
  /** Starts the poll; returns its stop function. */
  start(): () => void;
  /** The version in use (undefined before the first successful read). */
  version(): number | undefined;
}

export interface IdpClientSecretOptions {
  secrets: SecretStore;
  path: string;
  /** Where `secret.rotated` goes; without it (hermetic tests) nothing is recorded. */
  audit?: { writer: AuditWriter; orgId: string };
  pollMs?: number;
  logger?: Logger;
  metrics?: Metrics;
}

/** SHA-256 of the KV path: the event names the credential without naming where it lives. */
export function credentialRefHash(path: string): string {
  return createHash('sha256').update(path).digest('hex');
}

/** The one `secret.rotated` event for an observed IdP secret version (same id on every replica). */
export function idpSecretObservedEvent(orgId: string, path: string, version: number) {
  const refHash = credentialRefHash(path);
  return {
    ...systemEvent({
      action: 'secret.rotated',
      outcome: 'success',
      service: 'rts',
      details: {
        credential_ref_hash: refHash,
        kind: 'idp_client_secret',
        version,
        phase: 'observed',
      },
    }),
    event_id: derivedEventId(
      'secret.rotated',
      orgId,
      refHash,
      'idp_client_secret',
      String(version),
    ),
  };
}

export function createIdpClientSecret(options: IdpClientSecretOptions): IdpClientSecret {
  const logger = options.logger ?? silentLogger;
  const metrics = options.metrics ?? noopMetrics;
  const pollMs = options.pollMs ?? IDP_CLIENT_SECRET_POLL_S * 1000;
  let held: SecretValue | undefined;
  let reading: Promise<SecretValue> | undefined;
  /** Versions adopted here whose event hasn't landed yet (retried on the next poll). */
  const unrecorded = new Set<number>();
  let failingSince: number | undefined;
  /** True while the store answers an older version than the one held (one warning per streak). */
  let regressed = false;

  const record = async (version: number): Promise<void> => {
    if (options.audit === undefined) return;
    try {
      await options.audit.writer.writeOrSpool(options.audit.orgId, [
        idpSecretObservedEvent(options.audit.orgId, options.path, version),
      ]);
      unrecorded.delete(version);
    } catch (error) {
      unrecorded.add(version);
      metrics.increment('secret_rotated_record_failures_total', { kind: 'idp_client_secret' });
      logger.error('idp_client_secret_event_not_recorded', {
        version,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  };

  /** Records every adopted version not yet recorded; one flush at a time. */
  let flushing: Promise<void> | undefined;
  const flushRecords = (): Promise<void> => {
    flushing ??= (async () => {
      for (const version of [...unrecorded].sort((a, b) => a - b)) await record(version);
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  };

  /** Takes `next` if it is newer than what is held. */
  const adopt = (next: SecretValue, via: 'first_read' | 'poll' | 'invalid_client'): SecretValue => {
    if (held !== undefined && next.version < held.version) {
      // KV versions only grow, unless the entry's metadata was deleted and the path rewritten
      // (versions restart at 1) or a replica reads a restored store. Keep the value in hand, and
      // say so once per streak: the runbook restarts every replica (R35-4).
      if (!regressed) {
        regressed = true;
        metrics.increment('idp_client_secret_version_regressed_total');
        logger.warn('idp_client_secret_version_regressed', {
          held_version: held.version,
          store_version: next.version,
        });
      }
      return held;
    }
    regressed = false;
    if (held !== undefined && next.version === held.version) return held;
    const previous = held?.version;
    held = next;
    logger.info('idp_client_secret_observed', {
      version: next.version,
      ...(previous === undefined ? {} : { previous_version: previous }),
      via,
    });
    metrics.gauge('idp_client_secret_version', next.version);
    unrecorded.add(next.version);
    // A poll records when it ends; the other paths record now.
    if (via !== 'poll') void flushRecords();
    return held;
  };

  /** One store read at a time; concurrent callers share it. */
  const read = (via: 'first_read' | 'poll' | 'invalid_client'): Promise<SecretValue> => {
    reading ??= options.secrets
      .get(options.path)
      .then((value) => {
        if (failingSince !== undefined) {
          logger.info('idp_client_secret_read_recovered', { version: value.version });
          failingSince = undefined;
        }
        return adopt(value, via);
      })
      .finally(() => {
        reading = undefined;
      });
    return reading;
  };

  /** Counts a failed store read and logs it once per failure streak; the value in hand stays. */
  const readFailed = (error: unknown, via: 'poll' | 'invalid_client'): void => {
    metrics.increment('idp_client_secret_read_failures_total', { via });
    if (failingSince === undefined) {
      failingSince = Date.now();
      logger.warn('idp_client_secret_read_failed', {
        error: error instanceof Error ? error.name : 'unknown',
        code: (error as { code?: unknown }).code,
        version_in_use: held?.version,
        via,
      });
    }
  };

  let polling = false;
  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      await read('poll');
    } catch (error) {
      readFailed(error, 'poll');
    } finally {
      await flushRecords();
      polling = false;
    }
  };

  return {
    current: () => (held === undefined ? read('first_read') : Promise.resolve(held)),

    async refreshAfterInvalidClient(used) {
      let next: SecretValue;
      try {
        next = await read('invalid_client');
      } catch (error) {
        // The caller fails the request as unavailable (R35 nit).
        readFailed(error, 'invalid_client');
        throw error;
      }
      const retry = next.version !== used;
      metrics.increment('idp_invalid_client_total', { retried: String(retry) });
      logger.warn('idp_invalid_client', { version_used: used, version_now: next.version, retry });
      return retry ? next : undefined;
    },

    start() {
      void poll();
      const timer = setInterval(() => void poll(), pollMs);
      timer.unref();
      return () => {
        clearInterval(timer);
      };
    },

    version: () => held?.version,
  };
}
