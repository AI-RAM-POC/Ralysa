// Hermetic parts of the audit endpoints (F-002-T12): the per-service allow-list and its config
// validation (TC-F-002-37, SEC-F002-03), the service → source mapping, client_seq bookkeeping
// ([AR-14]), kill-switch scopes (TM-48), the per-service rejection aggregation (T11-2), and the
// query cursor.
import { describe, expect, it } from 'vitest';
import {
  disallowedActions,
  serviceMayWrite,
  sourceForService,
} from '../src/audit/action-allowlist.js';
import {
  applySeq,
  clientSeqGapEvent,
  formatMultirange,
  gapEventId,
  parseMultirange,
  tailGap,
} from '../src/audit/client-sessions.js';
import type { StoredEventInput } from '../src/audit/columns.js';
import { decodeCursor, encodeCursor } from '../src/audit/routes/query.js';
import { createServiceRejections } from '../src/audit/service-rejections.js';
import { validateStoredEvent } from '../src/audit/writer.js';
import { recordingWriter } from './fixtures/fake-rts.js';
import { coveringKillSwitch } from '../src/governance/kill-switch.js';
import { silentLogger } from '../src/observability/logger.js';
import { ConfigError } from '../src/config/load.js';
import { serveConfig } from './fixtures/serve-config.js';

const ORG = '0192f0a0-7b3c-7d4e-8f00-00000000000f';

describe('per-service action allow-list (SEC-F002-03)', () => {
  const gateway = {
    auditActions: ['model.call.completed', 'auth.token_rejected', 'secret.rotated'],
  };

  it('allows exactly the listed actions', () => {
    expect(serviceMayWrite(gateway, 'model.call.completed')).toBe(true);
    expect(serviceMayWrite(gateway, 'auth.token_rejected')).toBe(true);
    expect(serviceMayWrite(gateway, 'secret.rotated')).toBe(true);
    expect(serviceMayWrite(gateway, 'model.call.requested')).toBe(false);
  });

  it('never lets a reserved action through, even if a config listed it', () => {
    const forged = { auditActions: ['auth.sign_in', 'audit.query', 'db.migration.applied'] };
    for (const action of forged.auditActions) expect(serviceMayWrite(forged, action)).toBe(false);
  });

  it('reports each disallowed action once, in order', () => {
    expect(
      disallowedActions(gateway, [
        'model.call.completed',
        'auth.sign_in',
        'audit.query',
        'auth.sign_in',
        'tool.call.completed',
      ]),
    ).toEqual(['auth.sign_in', 'audit.query', 'tool.call.completed']);
  });

  it('maps service names to audit sources, and nothing else', () => {
    expect(sourceForService('model-gateway')).toBe('model-gateway');
    expect(sourceForService('mcp-gateway')).toBe('mcp-gateway');
    expect(sourceForService('workspace-runtime')).toBe('workspace-runtime');
    expect(sourceForService('agent-host')).toBe('agent-host-server');
    // One name per source (review of #33, R33-6): agent-host-server is not a service name.
    expect(sourceForService('agent-host-server')).toBeUndefined();
    expect(sourceForService('control-plane')).toBeUndefined();
    expect(sourceForService('agent-host-local')).toBeUndefined();
    expect(sourceForService('toString')).toBeUndefined();
    expect(sourceForService('t11gw-abc')).toBeUndefined();
  });
});

describe('TC-F-002-37: service allow-list validation at config load', () => {
  const withActions = (auditActions: string[]) => () =>
    serveConfig({
      services: [
        {
          name: 'model-gateway',
          client_id: 'svc:model-gateway',
          transit_key: 'ralysa-svc-model-gateway',
          audit_actions: auditActions,
        },
      ],
    });

  it.each([
    'auth.sign_in',
    'auth.refresh',
    'audit.query',
    'audit.ingest_rejected',
    'secret.custody_violation',
    'directory.user.provisioned',
    'db.migration.applied',
    'policy.version.published',
    'kill_switch.activated',
  ])('refuses the reserved action %s', (action) => {
    expect(withActions(['model.call.completed', action])).toThrow(ConfigError);
  });

  it('accepts the two reserved exceptions and ordinary actions', () => {
    expect(
      withActions(['model.call.completed', 'auth.token_rejected', 'secret.rotated']),
    ).not.toThrow();
  });
});

describe('client_seq bookkeeping ([AR-14])', () => {
  it('parses and formats int8multirange text (half-open, canonical)', () => {
    expect(parseMultirange('{}')).toEqual([]);
    expect(parseMultirange('{[3,5),[7,8)}')).toEqual([
      [3, 4],
      [7, 7],
    ]);
    expect(
      formatMultirange([
        [3, 4],
        [7, 7],
      ]),
    ).toBe('{[3,5),[7,8)}');
    expect(formatMultirange([])).toBe('{}');
    expect(
      formatMultirange([
        [5, 6],
        [3, 4],
      ]),
    ).toBe('{[3,7)}');
  });

  it('next, gap, late and conflict', () => {
    let state = { lastSeq: 0, openGaps: [] as readonly (readonly [number, number])[] };
    let r = applySeq(state, 1);
    expect(r.verdict).toEqual({ kind: 'next' });
    state = r.state;
    r = applySeq(state, 5);
    expect(r.verdict).toEqual({ kind: 'gap', gap: [2, 4] });
    state = r.state;
    expect(state).toEqual({ lastSeq: 5, openGaps: [[2, 4]] });
    r = applySeq(state, 3);
    expect(r.verdict).toEqual({ kind: 'late' });
    state = r.state;
    expect(state.openGaps).toEqual([
      [2, 2],
      [4, 4],
    ]);
    expect(applySeq(state, 3).verdict).toEqual({ kind: 'conflict' });
    expect(applySeq(state, 5).verdict).toEqual({ kind: 'conflict' });
    expect(applySeq(state, 1).verdict).toEqual({ kind: 'conflict' });
    r = applySeq(state, 2);
    r = applySeq(r.state, 4);
    expect(r.state.openGaps).toEqual([]);
  });

  it('the missing tail up to final_seq', () => {
    expect(tailGap({ lastSeq: 7, openGaps: [] }, 9)).toEqual([8, 9]);
    expect(tailGap({ lastSeq: 7, openGaps: [] }, 7)).toBeUndefined();
    expect(tailGap({ lastSeq: 7, openGaps: [] }, 3)).toBeUndefined();
  });

  it('gap events have stable ids per range and are valid envelopes', () => {
    const owner = { orgId: ORG, userId: ORG, idpSubject: 'oid', sessionId: ORG };
    const event = clientSeqGapEvent(owner, [2, 4], 'session_ended');
    expect(event.event_id).toBe(gapEventId(ORG, ORG, [2, 4]));
    expect(event.event_id).not.toBe(gapEventId(ORG, ORG, [2, 5]));
    expect(event).toMatchObject({
      action: 'audit.client_seq_gap',
      outcome: 'error',
      details: { session_id: ORG, missing_from: 2, missing_to: 4, cause: 'session_ended' },
    });
    expect(() => {
      validateStoredEvent(event);
    }).not.toThrow();
  });
});

describe('kill-switch scopes (TM-48, [AR-14])', () => {
  const subject = { orgId: ORG, departmentId: 'dept-1', packId: 'finance', agentId: 'ap-bot' };
  it.each([
    [{ scope: 'tenant', scopeId: null }, true],
    [{ scope: 'tenant', scopeId: ORG }, true],
    [{ scope: 'tenant', scopeId: 'another-org' }, false],
    [{ scope: 'department', scopeId: 'dept-1' }, true],
    [{ scope: 'department', scopeId: 'dept-2' }, false],
    [{ scope: 'pack', scopeId: 'finance' }, true],
    [{ scope: 'pack', scopeId: 'hr' }, false],
    [{ scope: 'agent', scopeId: 'ap-bot' }, true],
    [{ scope: 'agent', scopeId: 'other-bot' }, false],
  ] as const)('%o covers: %s', (s, covers) => {
    expect(coveringKillSwitch([s], subject) !== undefined).toBe(covers);
  });

  it('a department switch needs a department; pack and agent need the host to declare them', () => {
    const bare = { orgId: ORG, departmentId: null };
    expect(coveringKillSwitch([{ scope: 'department', scopeId: 'dept-1' }], bare)).toBeUndefined();
    expect(coveringKillSwitch([{ scope: 'pack', scopeId: 'finance' }], bare)).toBeUndefined();
    expect(coveringKillSwitch([{ scope: 'agent', scopeId: 'ap-bot' }], bare)).toBeUndefined();
  });
});

describe('service rejection reports (T11-2, SEC-F002-16)', () => {
  const report = (n: number, over: Record<string, unknown> = {}) => ({
    eventId: `0192f0a0-7b3c-7d4e-8f00-${n.toString(16).padStart(12, '0')}`,
    service: 'model-gateway',
    source: 'model-gateway' as const,
    orgId: ORG,
    reason: 'expired',
    audience: 'model-gateway',
    clientIp: '203.0.113.9',
    traceId: 'a'.repeat(32),
    ...over,
  });

  it('writes the first 20 per network individually under the service source, then summarises', () => {
    const events: StoredEventInput[] = [];
    let t = 0;
    const rejections = createServiceRejections({
      writer: recordingWriter(events),
      logger: silentLogger,
      now: () => t,
    });
    for (let i = 0; i < 25; i++) rejections.record(report(i));
    expect(events).toHaveLength(20);
    expect(events.every((e) => e.source === 'model-gateway')).toBe(true);
    expect(events[0]?.details).toMatchObject({
      reason: 'expired',
      client_ip: '203.0.113.9',
      client_network: '203.0.113.0/24',
    });
    t = 60_001;
    rejections.flush();
    expect(events).toHaveLength(21);
    expect(events[20]?.details).toMatchObject({ suppressed_count: 5 });
  });

  it('a repeated report id is a duplicate; dropped counts go to the overflow summary', () => {
    const events: StoredEventInput[] = [];
    let t = 0;
    const rejections = createServiceRejections({
      writer: recordingWriter(events),
      logger: silentLogger,
      now: () => t,
    });
    expect(rejections.record(report(1))).toBe('written');
    expect(rejections.record(report(1))).toBe('duplicate');
    expect(rejections.record(report(2, { clientIp: '', droppedCount: 40 }))).toBe('suppressed');
    t = 60_001;
    rejections.flush();
    expect(events.map((e) => e.details)).toEqual([
      expect.objectContaining({ client_ip: '203.0.113.9' }),
      expect.objectContaining({ client_network: 'overflow', suppressed_count: 40 }),
    ]);
    expect(events[1]?.details).not.toHaveProperty('client_ip');
  });

  it('each service has its own 600-a-minute cap', () => {
    const events: StoredEventInput[] = [];
    const rejections = createServiceRejections({
      writer: recordingWriter(events),
      logger: silentLogger,
      now: () => 0,
    });
    // 700 distinct /24s from one service: capped at 600 individual events.
    for (let i = 0; i < 700; i++) {
      rejections.record(report(i, { clientIp: `10.${String(i >> 8)}.${String(i & 255)}.1` }));
    }
    expect(events).toHaveLength(600);
    // Another service still has its whole budget.
    rejections.record(
      report(10_000, { service: 'mcp-gateway', source: 'mcp-gateway', clientIp: '10.9.9.9' }),
    );
    expect(events).toHaveLength(601);
    expect(events.at(-1)?.source).toBe('mcp-gateway');
  });
});

describe('audit query cursor', () => {
  it('round-trips and refuses anything else', () => {
    const id = '0192f0a0-7b3c-7d4e-8f00-0000000000a1';
    const cursor = encodeCursor('2026-09-26T10:00:00.123Z', id);
    expect(decodeCursor(cursor)).toEqual(['2026-09-26T10:00:00.123Z', id]);
    expect(decodeCursor('not base64 !')).toBeUndefined();
    expect(decodeCursor(Buffer.from('["x","y"]').toString('base64url'))).toBeUndefined();
    expect(decodeCursor(Buffer.from('{').toString('base64url'))).toBeUndefined();
  });
});
