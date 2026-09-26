// Waiting for the control plane's fire-and-forget audit writes in tests (issue #43).
//
// AuditWriter.write races the insert against its 250 ms budget (src/audit/writer.ts). When the
// budget runs out first, the promise the caller holds rejects, but the transaction keeps running
// and may commit afterwards. That is by design: the caller spools, and a replay of the same
// event_id comes back `duplicate`. So "every writer promise has settled" does NOT mean "every row
// is in". On a slow runner, where the writer pool is small and a burst of single-event writes
// queues for a connection, a test reading audit.audit_event right after the promises settled
// could miss a row that committed a moment later (TC-F-002-10 read 19 of 20, #43).
//
// `settled()` waits for both conditions: the tracked promises have settled, and the writer's pool
// is idle (no client checked out, none waiting for one). A late transaction holds its pool client,
// or waits for one, until its COMMIT or ROLLBACK returns, and it has always reached the pool by the
// time its 250 ms timer fires. The wait is event-driven (pg-pool `release`/`remove`), not a sleep.
import type pg from 'pg';
import type { AuditWriter } from '../../../src/audit/writer.js';

export interface TrackedAuditWriter {
  /** The writer to hand to the app: every call is tracked. */
  writer: AuditWriter;
  /** Resolves once every tracked write has settled AND its transaction has ended. */
  settled(): Promise<void>;
}

/** Wraps `real`, which must be the only user of `pool`. */
export function trackAuditWriter(real: AuditWriter, pool: pg.Pool): TrackedAuditWriter {
  const pending = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p);
    void p.finally(() => pending.delete(p)).catch(() => undefined);
    return p;
  };
  const idle = () => pool.waitingCount === 0 && pool.idleCount === pool.totalCount;
  // pg-pool emits `release` before it puts the client back on the idle list, so the check runs
  // again after the listener returns (the awaiting code resumes in a later microtask).
  const nextRelease = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        pool.off('release', done);
        pool.off('remove', done);
        resolve();
      };
      pool.on('release', done);
      pool.on('remove', done);
    });
  return {
    writer: {
      write: (org, events) => track(real.write(org, events)),
      writeOrSpool: (org, events) => track(real.writeOrSpool(org, events)),
    },
    async settled() {
      for (;;) {
        while (pending.size > 0) await Promise.allSettled([...pending]);
        if (idle()) return;
        await nextRelease();
      }
    },
  };
}
