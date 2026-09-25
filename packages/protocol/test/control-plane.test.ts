// @ralysa/protocol/control-plane: REST types (F-002 design §3.4; AC-2, AC-4, AC-12, AC-15, AC-16;
// [AR-18]).
import { describe, expect, it } from 'vitest';
import {
  AuditQuery,
  AuthConfig,
  ClientEventsRequest,
  GovernanceState,
  Me,
  Principal,
  ServiceEventsRequest,
  SignInFailureReport,
} from '../src/control-plane/index.js';

const uuid = (n: number) => `0192f0a0-7b3c-7d4e-8f00-${n.toString(16).padStart(12, '0')}`;

describe('auth config and sign-in failures', () => {
  it('flow B is always on; device code follows the tenant switch', () => {
    const config = {
      issuer: 'https://cp.example.test',
      flows: { idp_device: false, loopback_pkce: true },
      idp: {
        kind: 'entra',
        device_authorization_endpoint: 'https://login.example.test/devicecode',
        token_endpoint: 'https://login.example.test/token',
        cli_client_id: uuid(1),
        scope: 'api://rts/Ralysa.SignIn',
      },
      cli_client_id: 'ralysa-cli',
    };
    expect(AuthConfig.safeParse(config).success).toBe(true);
    expect(
      AuthConfig.safeParse({ ...config, flows: { idp_device: true, loopback_pkce: false } })
        .success,
    ).toBe(false);
  });

  it('[AR-18] idp_error_code is IdP-neutral: any short string, not an AADSTS pattern', () => {
    const report = { attempt_id: uuid(2), flow: 'idp_device', error: 'expired_token' };
    expect(
      SignInFailureReport.safeParse({ ...report, idp_error_code: 'AADSTS70020' }).success,
    ).toBe(true);
    expect(
      SignInFailureReport.safeParse({ ...report, idp_error_code: 'keycloak:expired' }).success,
    ).toBe(true);
    expect(
      SignInFailureReport.safeParse({ ...report, idp_error_code: 'x'.repeat(65) }).success,
    ).toBe(false);
    expect(SignInFailureReport.safeParse({ ...report, error: 'password_wrong' }).success).toBe(
      false,
    );
  });
});

describe('me and principals', () => {
  it('keeps Arabic display names byte-identical (AC-15)', () => {
    const me = {
      id: uuid(3),
      org_id: uuid(4),
      idp_subject: 'oid',
      email: null,
      display_name: 'فَاطِمَة',
      locale: 'ar',
      status: 'active',
      roles: ['user'],
      groups: [
        {
          id: uuid(5),
          idp_group_id: uuid(6),
          display_name: 'مُسْتَخْدِمُو رَلِيسَا',
          role: 'access',
        },
      ],
    };
    expect(Me.parse(me)).toEqual(me);
  });

  it('groups are matched by UUID object id only (SR-06)', () => {
    const principal = {
      user_id: uuid(3),
      org_id: uuid(4),
      status: 'active',
      roles: ['user', 'platform_admin'],
      groups: [{ idp_group_id: uuid(6), role: 'platform_admin' }],
      as_of: '2026-09-25T10:00:00Z',
    };
    expect(Principal.safeParse(principal).success).toBe(true);
    expect(
      Principal.safeParse({
        ...principal,
        groups: [{ idp_group_id: 'Ralysa Users', role: 'access' }],
      }).success,
    ).toBe(false);
  });
});

describe('governance feed', () => {
  it('parses a feed with revocations and kill switches', () => {
    expect(
      GovernanceState.safeParse({
        epoch: 7,
        issued_at: '2026-09-25T10:00:00Z',
        cursor: 'c1',
        revoked_sessions: [{ sid: uuid(7), revoked_at: '2026-09-25T09:59:00Z' }],
        users_revoked_before: [{ user_id: uuid(3), revoked_before: '2026-09-25T09:59:30Z' }],
        kill_switches: [{ scope: 'tenant', scope_id: null, active: false }],
      }).success,
    ).toBe(true);
  });
});

describe('audit API', () => {
  const clientEvent = (seq: number, action = 'tool.call.requested') => ({
    event_id: uuid(100 + seq),
    client_seq: seq,
    action,
    resource: { type: 'local_tool', id: 'bash' },
    operation: 'exec',
    outcome: null,
    reason_code: null,
    tool_call_id: 't1',
    turn_id: 'u1',
    trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    span_id: null,
    payload_hash: null,
    client: { pack_id: 'finance', client_ts: '2026-09-25T10:00:00Z' },
  });

  it('client events: allow-listed actions only, 1–50 per batch, no forged actor', () => {
    expect(
      ClientEventsRequest.safeParse({ events: [clientEvent(1, 'session.started')] }).success,
    ).toBe(true);
    expect(
      ClientEventsRequest.safeParse({ events: [clientEvent(1, 'auth.sign_in')] }).success,
    ).toBe(false);
    expect(ClientEventsRequest.safeParse({ events: [] }).success).toBe(false);
    expect(
      ClientEventsRequest.safeParse({
        events: Array.from({ length: 51 }, (_, i) => clientEvent(i + 1)),
      }).success,
    ).toBe(false);
    const forged = { ...clientEvent(1), actor: { type: 'user', user_id: uuid(9) } };
    expect(ClientEventsRequest.safeParse({ session_id: uuid(8), events: [forged] }).success).toBe(
      false,
    );
    expect(
      ClientEventsRequest.safeParse({ session_id: uuid(8), events: [{ ...clientEvent(0) }] })
        .success,
    ).toBe(false);
  });

  it('service events: 1–100 per batch', () => {
    const event = {
      event_id: uuid(1),
      action: 'model.call.completed',
      actor: { type: 'service', user_id: null, idp_subject: null, service: 'model-gateway' },
      outcome: 'success',
      trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
      details: {},
    };
    expect(ServiceEventsRequest.safeParse({ events: [event] }).success).toBe(true);
    expect(
      ServiceEventsRequest.safeParse({ events: Array.from({ length: 101 }, () => event) }).success,
    ).toBe(false);
  });

  it.each(['1', '99', '100', '499', '500'])('audit query accepts limit %s', (limit) => {
    expect(
      AuditQuery.safeParse({ from: '2026-09-01T00:00:00Z', to: '2026-09-25T00:00:00Z', limit })
        .success,
    ).toBe(true);
  });

  it.each(['0', '501', '1000', '-1', '1.5', 'x', '010'])(
    'audit query refuses limit %s',
    (limit) => {
      expect(
        AuditQuery.safeParse({ from: '2026-09-01T00:00:00Z', to: '2026-09-25T00:00:00Z', limit })
          .success,
      ).toBe(false);
    },
  );

  it('audit query requires from and to, and refuses unknown filters', () => {
    expect(AuditQuery.safeParse({ from: '2026-09-01T00:00:00Z' }).success).toBe(false);
    expect(
      AuditQuery.safeParse({
        from: '2026-09-01T00:00:00Z',
        to: '2026-09-02T00:00:00Z',
        org_id: uuid(1),
      }).success,
    ).toBe(false);
  });
});
