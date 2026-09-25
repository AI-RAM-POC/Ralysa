// AuditWriter (F-002 design §3.4.4, §5.8, §6.4; [AR-8]; ADR-0022). The control plane's own path
// into audit.audit_event, as ralysa_audit_writer:
//
// - write(): fail closed. Validates each event, then inserts it with a plain INSERT inside a
//   savepoint (no ON CONFLICT, no RETURNING: the writer role has no SELECT); SQLSTATE 23505 on
//   the primary key maps to `duplicate`. The whole call is bounded by 250 ms; any database error
//   or the timeout throws AuditUnavailableError, and the caller refuses the operation (e.g. no
//   tokens leave RTS without a committed auth.sign_in).
// - writeOrSpool(): for denials and non-blocking events (auth.token.issued, rejections). A denial
//   stands even when its audit write fails (ADR-0022 rule 5), so the event goes to the disk spool
//   and is replayed later with details.server.{original_ts, spooled} [SEC-F002-24].
import {
  AuditEventInput,
  findReservedKeys,
  iJsonViolations,
  outcomeAllowed,
} from '@ralysa/protocol/audit';
import { type Kysely, sql } from 'kysely';
import { withOrg } from '../db/kysely.js';
import type { Database } from '../db/types.js';
import { type Metrics, noopMetrics } from '../observability/metrics.js';
import { type StoredEventInput, toColumns } from './columns.js';
import type { AuditSpool } from './spool.js';

export const AUDIT_WRITE_TIMEOUT_MS = 250;

export type WriteStatus = 'stored' | 'duplicate';
export interface WriteResult {
  event_id: string;
  status: WriteStatus;
}

/** The audit store can't take the write now (maps to 503 `audit_unavailable`, §3.9). */
export class AuditUnavailableError extends Error {
  readonly code = 'audit_unavailable';
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`audit unavailable: ${reason}`, options);
    this.name = 'AuditUnavailableError';
  }
}

/** A malformed event is a programming error, never an availability problem. */
export class InvalidAuditEventError extends Error {
  constructor(eventId: string, reason: string) {
    super(`invalid audit event ${eventId}: ${reason}`);
    this.name = 'InvalidAuditEventError';
  }
}

export interface AuditWriterOptions {
  /** Kysely over the ralysa_audit_writer pool. */
  db: Kysely<Database>;
  timeoutMs?: number;
  spool?: AuditSpool;
  metrics?: Metrics;
}

export interface AuditWriter {
  write(orgId: string, events: readonly StoredEventInput[]): Promise<WriteResult[]>;
  writeOrSpool(
    orgId: string,
    events: readonly StoredEventInput[],
  ): Promise<{ results: WriteResult[] } | { spooled: number }>;
}

/**
 * Checks the rules zod can't carry (§3.5): I-JSON details [AR-5], `failure` on auth.* only
 * [AR-3], and no client-reserved key used as provenance by a server-attested event from outside.
 */
export function validateStoredEvent(event: StoredEventInput): void {
  const { attestation, client_seq } = event;
  // The input schema is strict: validate it without the server-assigned provenance fields.
  const input: Record<string, unknown> = { ...event };
  delete input.source;
  delete input.attestation;
  delete input.client_seq;
  const parsed = AuditEventInput.safeParse(input);
  if (!parsed.success) {
    throw new InvalidAuditEventError(
      event.event_id,
      parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', '),
    );
  }
  const violations = iJsonViolations(event.details, '$.details');
  if (violations.length > 0) {
    throw new InvalidAuditEventError(
      event.event_id,
      `details not I-JSON (${violations[0]?.path ?? ''})`,
    );
  }
  if (!outcomeAllowed(event.action, event.outcome)) {
    throw new InvalidAuditEventError(event.event_id, `outcome failure is for auth.* only [AR-3]`);
  }
  if (attestation === 'client' && findReservedKeys(event.details.client ?? {}).length > 0) {
    throw new InvalidAuditEventError(event.event_id, 'reserved key in details.client');
  }
  if (client_seq !== undefined && client_seq !== null && attestation !== 'client') {
    throw new InvalidAuditEventError(event.event_id, 'client_seq is only for client events');
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown }).code === '23505';
}

export function createAuditWriter(options: AuditWriterOptions): AuditWriter {
  const timeoutMs = options.timeoutMs ?? AUDIT_WRITE_TIMEOUT_MS;
  const metrics = options.metrics ?? noopMetrics;

  const insertAll = (orgId: string, events: readonly StoredEventInput[]) =>
    withOrg(options.db, orgId, async (trx) => {
      // Also bound each statement server-side, so a lock wait can't hold the connection.
      await sql`select set_config('statement_timeout', ${`${String(timeoutMs)}ms`}, true)`.execute(
        trx,
      );
      const results: WriteResult[] = [];
      for (const event of events) {
        await sql`savepoint audit_event`.execute(trx);
        try {
          await trx.insertInto('audit.audit_event').values(toColumns(orgId, event)).execute();
          await sql`release savepoint audit_event`.execute(trx);
          results.push({ event_id: event.event_id, status: 'stored' });
        } catch (error) {
          await sql`rollback to savepoint audit_event`.execute(trx);
          if (!isUniqueViolation(error)) throw error;
          results.push({ event_id: event.event_id, status: 'duplicate' });
        }
      }
      return results;
    });

  const write = async (orgId: string, events: readonly StoredEventInput[]) => {
    for (const event of events) validateStoredEvent(event);
    if (events.length === 0) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new AuditUnavailableError(`write exceeded ${String(timeoutMs)} ms`));
      }, timeoutMs);
    });
    // Design §5.8 (fail closed): a write that misses the 250 ms budget is REPORTED as failed and
    // the caller refuses (no tokens) or spools, but the transaction may still commit afterwards.
    // That is safe by construction: the operation it records was refused, and a later replay of
    // the same event_id (spool, retry) comes back as `duplicate`, never a second row.
    const attempt = insertAll(orgId, events);
    try {
      return await Promise.race([attempt, timeout]);
    } catch (error) {
      metrics.increment('audit_write_failures_total');
      // The insert may still settle after a timeout; never leave its rejection unhandled.
      attempt.catch(() => undefined);
      if (error instanceof AuditUnavailableError) throw error;
      throw new AuditUnavailableError('insert failed', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    write,
    async writeOrSpool(orgId, events) {
      try {
        return { results: await write(orgId, events) };
      } catch (error) {
        if (!(error instanceof AuditUnavailableError) || options.spool === undefined) throw error;
        await options.spool.append(orgId, events);
        metrics.increment('audit_spooled_total', {}, events.length);
        return { spooled: events.length };
      }
    },
  };
}
