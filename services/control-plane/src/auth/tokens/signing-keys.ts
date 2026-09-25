// RTS signing keys (F-002 design §3.2.4; SEC-F002-11, -33; AC-10).
//
// The key watcher polls the Transit key `ralysa-rts-signing` every key_poll_s (30 s):
// - custody: describe() refuses a key with `exportable` or `allow_plaintext_backup`. Then
//   signing stops, /readyz goes unready, and ONE secret.custody_violation is written. Signing
//   resumes when both flags are false again. Startup refuses such a key outright (main.ts);
// - publish: each version not yet in cp.signing_key_version gets a row with its public JWK
//   (first replica wins: INSERT … ON CONFLICT DO NOTHING RETURNING), which puts it in JWKS at once
//   and writes secret.rotated phase=published;
// - activate: the newest version whose published_at + activation_delay_s has passed on the
//   DATABASE clock becomes active (the first key ever is active at once); the replica that sets
//   activated_at writes phase=activated and marks the previous one superseded;
// - retire: a superseded version leaves JWKS once superseded_at + max access TTL + 5 min has
//   passed (phase=retired). tokens.signing_key_pin_version forces a version (rollback, §9).
// JWKS is always read from the table, so every replica publishes the same set [SEC-F002-33].
import { createHash } from 'node:crypto';
import { kidFor } from '@ralysa/protocol/auth';
import { CustodyViolationError, type KeyCustody, type PublicJwk } from '@ralysa/secrets';
import { type Kysely, sql } from 'kysely';
import { systemEvent } from '../../audit/events.js';
import type { AuditWriter } from '../../audit/writer.js';
import { withOrg } from '../../db/kysely.js';
import type { Database } from '../../db/types.js';
import type { Logger } from '../../observability/logger.js';
import { type Metrics, noopMetrics } from '../../observability/metrics.js';

export interface KeyRow {
  kid: string;
  version: number;
  public_jwk: PublicJwk;
  published_at: Date;
  activated_at: Date | null;
  superseded_at: Date | null;
  retired_at: Date | null;
}

export interface KeyTiming {
  activationDelayMs: number;
  /** How long a superseded key stays in JWKS: max access TTL + 5 min. */
  retentionMs: number;
  pinVersion?: number;
}

/** The version to sign with, or undefined when none may be used yet. Pure (unit-tested). */
export function selectActiveVersion(
  rows: readonly KeyRow[],
  now: Date,
  timing: KeyTiming,
): number | undefined {
  const live = rows.filter((r) => r.retired_at === null);
  if (timing.pinVersion !== undefined) {
    return live.some((r) => r.version === timing.pinVersion) ? timing.pinVersion : undefined;
  }
  const everActivated = live.some((r) => r.activated_at !== null);
  const eligible = live.filter(
    (r) =>
      r.activated_at !== null ||
      !everActivated ||
      r.published_at.getTime() + timing.activationDelayMs <= now.getTime(),
  );
  if (eligible.length === 0) return undefined;
  return Math.max(...eligible.map((r) => r.version));
}

/** The rows JWKS publishes: every live row (incl. published, not yet active), minus expired. */
export function jwksRows(rows: readonly KeyRow[], now: Date, timing: KeyTiming): KeyRow[] {
  return rows
    .filter(
      (r) =>
        r.retired_at === null &&
        (r.superseded_at === null ||
          r.superseded_at.getTime() + timing.retentionMs > now.getTime()),
    )
    .sort((a, b) => b.version - a.version);
}

export interface Jwk extends PublicJwk {
  kid: string;
  alg: 'ES256';
  use: 'sig';
}

export interface SigningKeysOptions {
  db: Kysely<Database>;
  custody: KeyCustody;
  orgId: string;
  key: string;
  timing: KeyTiming;
  writer: AuditWriter;
  logger: Logger;
  metrics?: Metrics;
  /** /readyz turns unready when no poll has succeeded for this long (default 30 s). */
  staleAfterMs?: number;
}

export interface SigningKeys {
  poll(): Promise<void>;
  /**
   * Signs with the active version. `build` receives that version's kid (it goes into the JOSE
   * header) and returns the bytes to sign. Throws SigningUnavailableError when signing isn't
   * allowed (custody violation, no active key, stale key state).
   */
  sign(
    build: (kid: string) => Uint8Array,
  ): Promise<{ kid: string; input: Uint8Array; signature: Uint8Array }>;
  jwks(): Promise<{ keys: Jwk[] }>;
  status(): {
    ready: boolean;
    activeVersion: number | undefined;
    custodyViolation: string | undefined;
  };
}

export class SigningUnavailableError extends Error {
  constructor(reason: string) {
    super(`signing unavailable: ${reason}`);
    this.name = 'SigningUnavailableError';
  }
}

const refHash = (key: string): string =>
  createHash('sha256').update(`transit/${key}`).digest('hex');

export function createSigningKeys(options: SigningKeysOptions): SigningKeys {
  const metrics = options.metrics ?? noopMetrics;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  let active: number | undefined;
  let violation: string | undefined;
  let lastPollOk = 0;

  const audit = async (event: Parameters<typeof systemEvent>[0]) => {
    try {
      await options.writer.writeOrSpool(options.orgId, [systemEvent(event)]);
    } catch (error) {
      options.logger.error('key_event_not_recorded', {
        action: event.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const rotated = (version: number, phase: 'published' | 'activated' | 'retired') =>
    audit({
      action: 'secret.rotated',
      outcome: 'success',
      service: 'rts',
      details: { credential_ref_hash: refHash(options.key), kind: 'signing_key', version, phase },
    });

  const readRows = () =>
    withOrg(options.db, options.orgId, async (trx) => {
      const rows = await trx.selectFrom('cp.signing_key_version').selectAll().execute();
      const { rows: clock } = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(
        trx,
      );
      return {
        now: clock[0]?.now ?? new Date(),
        rows: rows.map((r): KeyRow => ({
          kid: r.kid,
          version: r.version,
          public_jwk: r.public_jwk as PublicJwk,
          published_at: r.published_at,
          activated_at: r.activated_at,
          superseded_at: r.superseded_at,
          retired_at: r.retired_at,
        })),
      };
    });

  return {
    async poll() {
      let described;
      try {
        described = await options.custody.describe(options.key);
      } catch (error) {
        if (error instanceof CustodyViolationError) {
          const flag = error.exportable ? 'exportable' : 'allow_plaintext_backup';
          if (violation !== flag) {
            violation = flag;
            options.logger.error('secret_custody_violation', { key: options.key, flag });
            metrics.gauge('secret_custody_violation', 1, { key: options.key });
            await audit({
              action: 'secret.custody_violation',
              outcome: 'error',
              service: 'rts',
              reasonCode: flag,
              details: { key: options.key, flag },
            });
          }
          return;
        }
        options.logger.warn('signing_key_describe_failed', {
          key: options.key,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (violation !== undefined) {
        options.logger.info('secret_custody_restored', { key: options.key });
        metrics.gauge('secret_custody_violation', 0, { key: options.key });
        violation = undefined;
      }

      // Publish every version we don't have yet.
      for (const version of described.versions) {
        const kid = kidFor(options.key, version.version);
        const inserted = await withOrg(options.db, options.orgId, (trx) =>
          trx
            .insertInto('cp.signing_key_version')
            .values({
              kid,
              org_id: options.orgId,
              version: version.version,
              public_jwk: JSON.stringify(version.jwk),
            })
            .onConflict((oc) => oc.column('kid').doNothing())
            .returning('kid')
            .executeTakeFirst(),
        );
        if (inserted !== undefined) await rotated(version.version, 'published');
      }

      const { now, rows } = await readRows();
      const next = selectActiveVersion(rows, now, options.timing);
      if (next !== undefined) {
        const row = rows.find((r) => r.version === next);
        if (row !== undefined && row.activated_at === null) {
          const won = await withOrg(options.db, options.orgId, async (trx) => {
            const updated = await trx
              .updateTable('cp.signing_key_version')
              .set({ activated_at: sql<Date>`clock_timestamp()` })
              .where('kid', '=', row.kid)
              .where('activated_at', 'is', null)
              .returning('kid')
              .executeTakeFirst();
            await trx
              .updateTable('cp.signing_key_version')
              .set({ superseded_at: sql<Date>`clock_timestamp()` })
              .where('version', '<', next)
              .where('activated_at', 'is not', null)
              .where('superseded_at', 'is', null)
              .execute();
            return updated !== undefined;
          });
          if (won) await rotated(next, 'activated');
        }
      }
      for (const row of rows) {
        if (
          row.retired_at === null &&
          row.superseded_at !== null &&
          row.superseded_at.getTime() + options.timing.retentionMs <= now.getTime()
        ) {
          const retired = await withOrg(options.db, options.orgId, (trx) =>
            trx
              .updateTable('cp.signing_key_version')
              .set({ retired_at: sql<Date>`clock_timestamp()` })
              .where('kid', '=', row.kid)
              .where('retired_at', 'is', null)
              .returning('kid')
              .executeTakeFirst(),
          );
          if (retired !== undefined) await rotated(row.version, 'retired');
        }
      }
      if (active !== next)
        options.logger.info('signing_key_active', { key: options.key, version: next });
      active = next;
      lastPollOk = Date.now();
    },

    async sign(build) {
      if (violation !== undefined) throw new SigningUnavailableError('custody violation');
      const version = active;
      if (version === undefined) throw new SigningUnavailableError('no active signing key');
      if (Date.now() - lastPollOk > staleAfterMs)
        throw new SigningUnavailableError('key state is stale');
      const kid = kidFor(options.key, version);
      const input = build(kid);
      return { kid, input, signature: await options.custody.sign(options.key, version, input) };
    },

    async jwks() {
      const { now, rows } = await readRows();
      return {
        keys: jwksRows(rows, now, options.timing).map((r) => ({
          kty: 'EC' as const,
          crv: 'P-256' as const,
          x: r.public_jwk.x,
          y: r.public_jwk.y,
          kid: r.kid,
          alg: 'ES256' as const,
          use: 'sig' as const,
        })),
      };
    },

    status() {
      const fresh = Date.now() - lastPollOk <= staleAfterMs;
      return {
        ready: violation === undefined && active !== undefined && fresh,
        activeVersion: active,
        custodyViolation: violation,
      };
    },
  };
}
