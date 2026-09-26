// RTS signing keys (F-002 design §3.2.4; SEC-F002-11, -33; AC-10).
//
// The key watcher polls the Transit key `ralysa-rts-signing` every key_poll_s (30 s):
// - custody: describe() refuses a key with `exportable` or `allow_plaintext_backup`, and a stored
//   version whose public key differs from Transit's means the key was recreated under the same
//   name. Any of these stops signing FOR THE LIFE OF THE PROCESS (Transit can't clear the flags,
//   SEC-F002-35 a), makes /readyz unready, and records secret.custody_violation with every flag,
//   retried on each poll until it lands (mirrors the sealer, SEC-F002-39/-40). Startup refuses such
//   a key outright (serve.ts);
// - publish: each version not yet in cp.signing_key_version gets a row with its public JWK
//   (first replica wins: INSERT … ON CONFLICT DO NOTHING RETURNING), which puts it in JWKS at once
//   and writes secret.rotated phase=published;
// - activate: the newest version whose published_at + activation_delay_s has passed on the
//   DATABASE clock becomes active (the first key ever is active at once); the replica that sets
//   activated_at writes phase=activated;
// - supersede: on EVERY poll, from any replica, every live version below the selected one that
//   has no superseded_at is marked superseded, including one that was published but never
//   activated (several versions at the first start, or two rotations within one poll), so none
//   stays in JWKS for ever (T07 follow-up, review of #35). Guarded by superseded_at IS NULL, so
//   racing replicas change each row once;
// - pin (rollback, design §9): tokens.signing_key_pin_version forces a version. While pinned,
//   the versions ABOVE the pin that were ever active are superseded too, so the bad version
//   leaves JWKS after the retention even though the pin holds (review of #37);
// - un-supersede: the selected version never carries superseded_at, pinned or not. A pinned
//   version that had been superseded is live again (phase=pinned), and a newer version that the
//   pin had superseded and that has not retired yet signs again once the pin is removed
//   (phase=reactivated); the lower versions are superseded again on the same poll. The replica
//   whose guarded UPDATE changed the row writes the event (#36, review of #37);
// - retire: a superseded version leaves JWKS once superseded_at + max access TTL + 5 min has
//   passed on the database clock (phase=retired). The selected (and the pinned) version is never
//   retired, and the UPDATE re-checks superseded_at itself, so a version un-superseded on the same
//   poll can't retire from a stale read.
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

/**
 * The versions to mark superseded while `selected` signs: every lower live version not yet
 * superseded, whether or not it was ever active. While `selected` is the pin (a rollback, §9),
 * also every higher live version that was ever active, so the bad version retires after the
 * retention even though the pin holds (review of #37). A higher version never activated is left
 * alone: it is only published, and activates once the pin is removed. Pure (unit-tested); poll()
 * supersedes exactly these.
 */
export function versionsToSupersede(
  rows: readonly KeyRow[],
  selected: number,
  pinVersion?: number,
): number[] {
  const pinned = pinVersion === selected;
  return rows
    .filter(
      (r) =>
        r.superseded_at === null &&
        r.retired_at === null &&
        (r.version < selected || (pinned && r.version > selected && r.activated_at !== null)),
    )
    .map((r) => r.version)
    .sort((a, b) => a - b);
}

/**
 * The selected version, when its row still carries superseded_at: the version that signs is
 * never superseded, pinned or not (#36, review of #37). Pure (unit-tested); poll() clears
 * superseded_at on exactly this one.
 */
export function versionToUnsupersede(
  rows: readonly KeyRow[],
  selected: number | undefined,
): number | undefined {
  const row = rows.find((r) => r.version === selected);
  return row !== undefined && row.retired_at === null && row.superseded_at !== null
    ? row.version
    : undefined;
}

/**
 * The versions to retire now: superseded for longer than the retention, never the pinned or the
 * selected one (a rollback must keep signing, #36). Pure (unit-tested); poll() retires exactly
 * these, and its UPDATE re-checks the retention on the database clock.
 */
export function versionsToRetire(
  rows: readonly KeyRow[],
  now: Date,
  timing: KeyTiming,
  selected?: number,
): number[] {
  return rows
    .filter(
      (r) =>
        r.retired_at === null &&
        r.superseded_at !== null &&
        r.version !== timing.pinVersion &&
        r.version !== selected &&
        r.superseded_at.getTime() + timing.retentionMs <= now.getTime(),
    )
    .map((r) => r.version)
    .sort((a, b) => a - b);
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

interface CustodyState {
  exportable: boolean;
  allowPlaintextBackup: boolean;
  keyReplaced: boolean;
}
const pairOf = (s: CustodyState): string =>
  `${String(s.exportable)}/${String(s.allowPlaintextBackup)}/${String(s.keyReplaced)}`;
const flagOf = (s: CustodyState): string =>
  s.keyReplaced ? 'key_replaced' : s.exportable ? 'exportable' : 'allow_plaintext_backup';

const refHash = (key: string): string =>
  createHash('sha256').update(`transit/${key}`).digest('hex');

export function createSigningKeys(options: SigningKeysOptions): SigningKeys {
  const metrics = options.metrics ?? noopMetrics;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  let active: number | undefined;
  /** Terminal once set: Transit can't clear the flags, and replaced material stays replaced. */
  let violation: CustodyState | undefined;
  let recordedPair: string | undefined;
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
  const rotated = (version: number, phase: 'published' | 'activated' | 'pinned' | 'reactivated' | 'retired') =>
    audit({
      action: 'secret.rotated',
      outcome: 'success',
      service: 'rts',
      details: { credential_ref_hash: refHash(options.key), kind: 'signing_key', version, phase },
    });

  /** Records the violation (both flags, SEC-F002-40), retried on every poll until it lands (-39). */
  const recordViolation = async (state: CustodyState) => {
    const pair = pairOf(state);
    if (recordedPair === pair) return;
    try {
      await options.writer.writeOrSpool(options.orgId, [
        systemEvent({
          action: 'secret.custody_violation',
          outcome: 'error',
          service: 'rts',
          reasonCode: flagOf(state),
          details: {
            key: options.key,
            flag: flagOf(state),
            exportable: state.exportable,
            allow_plaintext_backup: state.allowPlaintextBackup,
            key_replaced: state.keyReplaced,
          },
        }),
      ]);
      recordedPair = pair;
    } catch (error) {
      metrics.increment('secret_custody_violation_record_failures_total', { key: options.key });
      options.logger.error('secret_custody_violation_not_recorded', {
        key: options.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const flagViolation = async (next: CustodyState) => {
    const merged: CustodyState = {
      exportable: next.exportable || (violation?.exportable ?? false),
      allowPlaintextBackup: next.allowPlaintextBackup || (violation?.allowPlaintextBackup ?? false),
      keyReplaced: next.keyReplaced || (violation?.keyReplaced ?? false),
    };
    if (violation === undefined || pairOf(violation) !== pairOf(merged)) {
      options.logger.error('secret_custody_violation', {
        key: options.key,
        exportable: merged.exportable,
        allow_plaintext_backup: merged.allowPlaintextBackup,
        key_replaced: merged.keyReplaced,
      });
      metrics.gauge('secret_custody_violation', 1, { key: options.key });
    }
    violation = merged;
    await recordViolation(merged);
  };

  const readRows = () =>
    withOrg(options.db, options.orgId, async (trx) => {
      // Only this key's rows (kid = <key>.v<n>): version numbers alone don't identify a key.
      const rows = await trx
        .selectFrom('cp.signing_key_version')
        .selectAll()
        .where('kid', 'like', `${options.key.replace(/[\\%_]/g, '\\$&')}.v%`)
        .execute();
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
          await flagViolation({
            exportable: error.exportable,
            allowPlaintextBackup: error.allowPlaintextBackup,
            keyReplaced: false,
          });
          return;
        }
        options.logger.warn('signing_key_describe_failed', {
          key: options.key,
          error: error instanceof Error ? error.message : String(error),
        });
        if (violation !== undefined) await recordViolation(violation);
        return;
      }
      if (violation !== undefined) {
        // Terminal (SEC-F002-35 a): a flagged key that reads clean again has been recreated.
        options.logger.error('signing_key_clean_after_violation', { key: options.key });
        await recordViolation(violation);
        return;
      }
      // The same version number with different public material = the key was recreated under the
      // same name (SEC-F002-37): treat it as a custody violation, never sign with it.
      const stored = await readRows();
      const replaced = described.versions.some((v) => {
        const row = stored.rows.find((r) => r.version === v.version);
        return row !== undefined && (row.public_jwk.x !== v.jwk.x || row.public_jwk.y !== v.jwk.y);
      });
      if (replaced) {
        await flagViolation({ exportable: false, allowPlaintextBackup: false, keyReplaced: true });
        return;
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
      const kidOf = (version: number) => kidFor(options.key, version);
      if (next !== undefined) {
        const row = rows.find((r) => r.version === next);
        if (row !== undefined && row.activated_at === null) {
          const won = await withOrg(options.db, options.orgId, (trx) =>
            trx
              .updateTable('cp.signing_key_version')
              .set({ activated_at: sql<Date>`clock_timestamp()` })
              .where('kid', '=', row.kid)
              .where('activated_at', 'is', null)
              .returning('kid')
              .executeTakeFirst(),
          );
          if (won !== undefined) await rotated(next, 'activated');
        }
        // The selected version never carries superseded_at (versionToUnsupersede): a pinned
        // version the newer one had superseded, or, once the pin is removed, a newer version the
        // pin had superseded and that hasn't retired yet. Guarded, so one replica records it.
        const unsupersede = versionToUnsupersede(rows, next);
        if (unsupersede !== undefined) {
          const cleared = await withOrg(options.db, options.orgId, (trx) =>
            trx
              .updateTable('cp.signing_key_version')
              .set({ superseded_at: null })
              .where('kid', '=', kidOf(unsupersede))
              .where('superseded_at', 'is not', null)
              .where('retired_at', 'is', null)
              .returning('kid')
              .executeTakeFirst(),
          );
          if (cleared !== undefined) {
            const phase = options.timing.pinVersion === next ? 'pinned' : 'reactivated';
            options.logger.info('signing_key_unsuperseded', {
              key: options.key,
              version: next,
              phase,
            });
            await rotated(next, phase);
          }
        }
        // Every lower version not yet superseded (also one never active, or a former pin once the
        // pin is removed) and, while pinned, every newer version that was active
        // (versionsToSupersede, the unit-tested rule). Guarded, so racing replicas change each
        // row once.
        const supersede = versionsToSupersede(rows, next, options.timing.pinVersion);
        if (supersede.length > 0) {
          await withOrg(options.db, options.orgId, (trx) =>
            trx
              .updateTable('cp.signing_key_version')
              .set({ superseded_at: sql<Date>`clock_timestamp()` })
              .where('kid', 'in', supersede.map(kidOf))
              .where('superseded_at', 'is', null)
              .execute(),
          );
        }
      }
      // The retention is re-checked in the UPDATE on the database clock, so a version whose
      // superseded_at was cleared (or set again) since readRows() is left alone.
      const retentionMs = Math.max(0, Math.floor(options.timing.retentionMs));
      for (const version of versionsToRetire(rows, now, options.timing, next)) {
        const retired = await withOrg(options.db, options.orgId, (trx) =>
          trx
            .updateTable('cp.signing_key_version')
            .set({ retired_at: sql<Date>`clock_timestamp()` })
            .where('kid', '=', kidOf(version))
            .where('retired_at', 'is', null)
            .where('superseded_at', 'is not', null)
            .where(
              'superseded_at',
              '<=',
              sql<Date>`clock_timestamp() - make_interval(secs => ${retentionMs / 1000})`,
            )
            .returning('kid')
            .executeTakeFirst(),
        );
        if (retired !== undefined) await rotated(version, 'retired');
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
        custodyViolation: violation === undefined ? undefined : flagOf(violation),
      };
    },
  };
}
