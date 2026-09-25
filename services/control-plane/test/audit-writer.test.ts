// AuditWriter's event checks (the database behaviour is in test/integration/audit.int.ts).
import { describe, expect, it } from 'vitest';
import type { StoredEventInput } from '../src/audit/columns.js';
import { migrationAppliedEvents, systemEvent, tokenRejectedEvent } from '../src/audit/events.js';
import { InvalidAuditEventError, validateStoredEvent } from '../src/audit/writer.js';
import { migrationChecksums } from '../src/db/migration-checksums.js';

const ok: StoredEventInput = systemEvent({
  action: 'audit.query',
  outcome: 'success',
  service: 'control-plane',
  details: { filters: { action: 'auth.sign_in' } },
});

describe('validateStoredEvent', () => {
  it('accepts a valid server event', () => {
    expect(() => {
      validateStoredEvent(ok);
    }).not.toThrow();
  });

  it.each([
    ['failure outside auth.* [AR-3]', { outcome: 'failure' as const }],
    ['a non-I-JSON number in details', { details: { n: Number.NaN } }],
    ['an unsafe integer in details', { details: { n: 2 ** 60 } }],
    ['a bad action name', { action: 'Audit.Query' }],
    ['a bad trace id', { trace_id: 'x' }],
    ['client_seq on a server event', { client_seq: 3 }],
  ])('refuses %s', (_name, change) => {
    expect(() => {
      validateStoredEvent({ ...ok, ...change });
    }).toThrow(InvalidAuditEventError);
  });

  it('refuses unknown envelope members', () => {
    expect(() => {
      validateStoredEvent({ ...ok, extra: 1 } as unknown as StoredEventInput);
    }).toThrow(InvalidAuditEventError);
  });
});

describe('event builders', () => {
  it('system events use UUIDv7 ids, actor.type system and server attestation', () => {
    expect(ok.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(ok).toMatchObject({
      actor: { type: 'system', service: 'control-plane' },
      attestation: 'server',
    });
  });

  it('db.migration.applied carries set, migration and the lock checksum (SR-29)', () => {
    const checksums = migrationChecksums();
    expect(checksums['audit/0001_audit_store.ts']).toMatch(/^[0-9a-f]{64}$/);
    const [event] = migrationAppliedEvents('audit', ['0001_audit_store'], checksums);
    expect(event).toMatchObject({
      action: 'db.migration.applied',
      outcome: 'success',
      actor: { type: 'system', service: 'migrator' },
      details: {
        set: 'audit',
        migration: '0001_audit_store',
        checksum: checksums['audit/0001_audit_store.ts'],
      },
    });
    validateStoredEvent(event!);
    expect(() => migrationAppliedEvents('cp', ['9999_x'], checksums)).toThrow(/no checksum/);
  });

  it('auth.token_rejected carries the reason, audience and network; the summary adds suppressed_count', () => {
    const base = {
      orgId: '0192f0a0-7b3c-7d4e-8f00-00000000000f',
      clientIp: '10.1.2.3',
      reason: 'expired',
      audience: 'model-gateway',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      network: '10.1.2.0/24',
    };
    const single = tokenRejectedEvent(base);
    validateStoredEvent(single);
    expect(single.details).not.toHaveProperty('suppressed_count');
    expect(tokenRejectedEvent({ ...base, suppressedCount: 5 }).details).toMatchObject({
      suppressed_count: 5,
    });
  });
});
