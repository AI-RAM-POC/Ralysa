// @ralysa/protocol/audit: envelope shapes, action rules and reserved keys (F-002 design §3.4.4,
// §3.4.5, §3.5; AC-11, AC-13, AC-16; [AR-3]; SEC-F002-03, -15).
import { describe, expect, it } from 'vitest';
import {
  AUDIT_SCHEMA_VERSION,
  AuditEvent,
  AuditEventInput,
  CLIENT_ACTION_ALLOWLIST,
  F002_ACTIONS,
  Outcome,
  RESERVED_DETAIL_KEYS,
  findReservedKeys,
  isReservedAction,
  outcomeAllowed,
  serviceMayBeAllowListed,
} from '../src/audit/index.js';

const input = {
  event_id: '0192f0a0-7b3c-7d4e-8f00-000000000001',
  action: 'model.call.completed',
  actor: {
    type: 'user',
    user_id: '0192f0a0-7b3c-7d4e-8f00-0000000000aa',
    idp_subject: 'oid-1',
    service: null,
  },
  resource: { type: 'model_endpoint', id: 'ep-1' },
  outcome: 'success',
  trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
  endpoint_region: 'qa-doha-1',
  inference_region: 'qa-doha-1',
  inference_region_source: 'registry_declared',
  tokens_in: 10,
  tokens_out: 20,
  session_id: 's-1',
  details: { model_id: 'model-x' },
};

const stored = {
  ...input,
  schema_version: AUDIT_SCHEMA_VERSION,
  ts: '2026-09-25T10:00:00.123Z',
  org_id: '0192f0a0-7b3c-7d4e-8f00-00000000000f',
  source: 'model-gateway',
  attestation: 'server',
};

describe('AuditEventInput and AuditEvent', () => {
  it('accept the AC-11/AC-13 fields, including endpoint_region and inference_region (BC-04)', () => {
    expect(AuditEventInput.parse(input)).toEqual(input);
    expect(AuditEvent.parse(stored)).toEqual(stored);
  });

  it('refuse server-assigned fields in the input (the server sets source, org_id, ts)', () => {
    for (const extra of [
      { source: 'control-plane' },
      { org_id: stored.org_id },
      { ts: stored.ts },
    ]) {
      expect(AuditEventInput.safeParse({ ...input, ...extra }).success).toBe(false);
    }
  });

  it('refuse unknown members anywhere in the envelope', () => {
    expect(AuditEventInput.safeParse({ ...input, extra: 1 }).success).toBe(false);
    expect(
      AuditEventInput.safeParse({ ...input, actor: { ...input.actor, role: 'admin' } }).success,
    ).toBe(false);
  });

  it.each([
    '2026-09-25T10:00:00Z',
    '2026-09-25T10:00:00.12Z',
    '2026-09-25T10:00:00.1234Z',
    '2026-09-25T10:00:00.123+03:00',
  ])('[AR-5] ts must be UTC with exactly 3 fractional digits: refuses %s', (ts) => {
    expect(AuditEvent.safeParse({ ...stored, ts }).success).toBe(false);
  });

  it.each(['Auth.sign_in', 'auth', 'auth.a.b.c.d', 'auth.sign-in', 'auth..x'])(
    'refuses the action name %s',
    (action) => {
      expect(AuditEventInput.safeParse({ ...input, action }).success).toBe(false);
    },
  );

  it('schema_version is the literal 1', () => {
    expect(AuditEvent.safeParse({ ...stored, schema_version: 2 }).success).toBe(false);
  });

  it('refuses negative token counts and a bad region', () => {
    expect(AuditEventInput.safeParse({ ...input, tokens_in: -1 }).success).toBe(false);
    expect(AuditEventInput.safeParse({ ...input, inference_region: 'Qatar' }).success).toBe(false);
  });
});

describe('action rules', () => {
  it('[AR-3] failure is valid on auth.* only', () => {
    expect(outcomeAllowed('auth.sign_in', 'failure')).toBe(true);
    expect(outcomeAllowed('audit.query', 'failure')).toBe(false);
    expect(outcomeAllowed('tool.call.completed', 'failure')).toBe(false);
    for (const outcome of Outcome.options.filter((o) => o !== 'failure')) {
      expect(outcomeAllowed('audit.query', outcome)).toBe(true);
    }
  });

  it('every F-002 action is a valid action name', () => {
    for (const action of F002_ACTIONS) {
      expect(AuditEventInput.shape.action.safeParse(action).success).toBe(true);
    }
  });

  it('[SEC-F002-03] reserved namespaces: a service may only hold the two exceptions', () => {
    for (const action of [
      'auth.sign_in',
      'audit.query',
      'db.migration.applied',
      'policy.x',
      'kill_switch.set',
      'directory.user.updated',
      'secret.custody_violation',
    ]) {
      expect(isReservedAction(action)).toBe(true);
      expect(serviceMayBeAllowListed(action)).toBe(false);
    }
    expect(serviceMayBeAllowListed('auth.token_rejected')).toBe(true);
    expect(serviceMayBeAllowListed('secret.rotated')).toBe(true);
    expect(serviceMayBeAllowListed('model.call.completed')).toBe(true);
    // A look-alike outside the namespace is not reserved.
    expect(isReservedAction('authz.check')).toBe(false);
  });

  it('the client allow-list holds only local-host events, none reserved', () => {
    expect(CLIENT_ACTION_ALLOWLIST).toEqual([
      'tool.call.requested',
      'tool.call.completed',
      'tool.call.denied',
      'session.started',
      'session.ended',
      'hook.failed',
      'approval.presented',
    ]);
    for (const action of CLIENT_ACTION_ALLOWLIST) expect(isReservedAction(action)).toBe(false);
  });
});

describe('reserved details keys (SEC-F002-15)', () => {
  it('lists the server-owned keys', () => {
    expect(RESERVED_DETAIL_KEYS).toEqual([
      'server',
      'seq_gap',
      'late',
      'reported_by',
      'suppressed_count',
      'spooled',
      'original_ts',
    ]);
  });

  it('finds reserved keys at any depth, including inside arrays', () => {
    expect(
      findReservedKeys({ ok: 1, server: { x: 1 }, nested: { deeper: [{ late: true }] } }),
    ).toEqual(['server', 'nested.deeper[0].late']);
  });

  it('finds nothing in clean client data, and ignores reserved words used as values', () => {
    expect(findReservedKeys({ pack_id: 'p', note: 'server', list: ['late'] })).toEqual([]);
  });
});
