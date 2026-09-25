// RTS services for hermetic app tests: a database that is never reachable (routes that need it
// answer 503 or 500, which these tests don't exercise), an in-memory audit writer that records
// what it was given, the in-memory key custody, and the unconfigured IdP directory.
import { createInMemoryKeyCustody } from '@ralysa/secrets';
import pg from 'pg';
import type { StoredEventInput } from '../../src/audit/columns.js';
import { createRejectionAggregator } from '../../src/audit/rejections.js';
import type { AuditWriter } from '../../src/audit/writer.js';
import type { RtsServices } from '../../src/auth/deps.js';
import { unconfiguredDirectory } from '../../src/auth/directory-port.js';
import { createDb } from '../../src/db/kysely.js';
import type { Database } from '../../src/db/types.js';

export interface FakeRts extends RtsServices {
  events: StoredEventInput[];
}

export function recordingWriter(events: StoredEventInput[]): AuditWriter {
  return {
    write: (_org, batch) => {
      events.push(...batch);
      return Promise.resolve(
        batch.map((e) => ({ event_id: e.event_id, status: 'stored' as const })),
      );
    },
    writeOrSpool: (_org, batch) => {
      events.push(...batch);
      return Promise.resolve({
        results: batch.map((e) => ({ event_id: e.event_id, status: 'stored' as const })),
      });
    },
  };
}

export function fakeRts(overrides: Partial<RtsServices> = {}): FakeRts {
  const events: StoredEventInput[] = [];
  return {
    events,
    // Port 1 on loopback: nothing listens, and the pool only connects when a query runs.
    db: createDb<Database>(
      new pg.Pool({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 200 }),
    ),
    custody: createInMemoryKeyCustody(),
    directory: unconfiguredDirectory,
    writer: recordingWriter(events),
    rejections: createRejectionAggregator({ emit: () => undefined }),
    ...overrides,
  };
}
