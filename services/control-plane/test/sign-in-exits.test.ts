// AC-4 completeness (F-002 design §6.4): every exit of the token-exchange grant is enumerated and
// each writes EXACTLY ONE `auth.sign_in` event with the right outcome and reason, and answers
// the right OAuth error. Hermetic: the IdP validator, directory, store, writer and signer are
// fakes, so each exit is reached on purpose.
import { SIGN_IN_REASON_OUTCOMES, type SignInReason } from '@ralysa/protocol/auth';
import { describe, expect, it } from 'vitest';
import type { StoredEventInput } from '../src/audit/columns.js';
import { AuditUnavailableError, type AuditWriter } from '../src/audit/writer.js';
import type { DirectoryCheck } from '../src/auth/directory-port.js';
import { type ExchangeEnv, tokenExchangeGrant } from '../src/auth/grants/token-exchange.js';
import type { IdpIdentity, IdpTokenResult } from '../src/auth/idp/entra-token-validator.js';
import { policyVersion } from '../src/auth/policy-version.js';
import { SignInAttempt, SignInRecordedTwiceError } from '../src/auth/sign-in.js';
import type { SignInStore } from '../src/auth/sign-in-store.js';
import { OAuthProblem } from '../src/http/errors.js';
import { silentLogger } from '../src/observability/logger.js';
import { createMemoryMetrics } from '../src/observability/metrics.js';
import { serveConfig, serveConfigInput } from './fixtures/serve-config.js';

const ACCESS = '4f1c2e3d-0000-4000-8000-0000000000d1';
const ADMIN = '4f1c2e3d-0000-4000-8000-0000000000d2';
const OID = '6a0e5a4e-1111-4222-8333-444455556666';
const GRANT = {
  grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
  client_id: 'ralysa-cli',
  subject_token: 'header.payload.signature',
  subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
};

interface Scenario {
  name: string;
  body?: Record<string, string>;
  config?: Record<string, unknown>;
  token?: IdpTokenResult;
  identity?: Partial<IdpIdentity>;
  replayed?: boolean;
  directory?: DirectoryCheck;
  knownUser?: boolean;
  provisionFails?: boolean;
  consumeFails?: boolean;
  mintFails?: boolean;
  auditFails?: boolean;
  /** Expected auth.sign_in: outcome/reason, or none (not an attempt). */
  expect: { outcome: 'success' | 'failure' | 'denied' | 'error'; reason?: SignInReason } | 'none';
  error?: { status: number; error: string };
}

const ok: DirectoryCheck = {
  kind: 'ok',
  inAccessGroup: true,
  inAdminGroup: false,
  sessionsValidFrom: null,
};

function identity(over: Partial<IdpIdentity> = {}): IdpIdentity {
  const iat = Math.floor(Date.now() / 1000);
  return {
    issuer: `https://login.microsoftonline.com/4f1c2e3d-0000-4000-8000-0000000000aa/v2.0`,
    tenantId: '4f1c2e3d-0000-4000-8000-0000000000aa',
    oid: OID,
    uti: 'uti-value',
    iat,
    exp: iat + 3600,
    name: 'Alice',
    preferredUsername: 'alice@contoso.example',
    email: 'alice@contoso.example',
    amr: ['pwd', 'mfa'],
    acrs: [],
    ipaddr: '127.0.0.1',
    groups: { kind: 'list', guids: [ACCESS], ignored: 0 },
    ...over,
  };
}

const failure = (
  reason: 'invalid_idp_token' | 'untrusted_issuer' | 'expired' | 'idp_unavailable',
): IdpTokenResult => ({
  ok: false,
  reason,
  check: 'test',
  unverifiedIdentifier: 'someone@contoso.example',
});

const SCENARIOS: Scenario[] = [
  {
    name: 'malformed request (not an attempt)',
    body: { ...GRANT, client_id: 'other' },
    expect: 'none',
    error: { status: 400, error: 'invalid_request' },
  },
  {
    name: 'invalid IdP token',
    token: failure('invalid_idp_token'),
    expect: { outcome: 'failure', reason: 'invalid_idp_token' },
    error: { status: 400, error: 'invalid_grant' },
  },
  {
    name: 'untrusted issuer',
    token: failure('untrusted_issuer'),
    expect: { outcome: 'failure', reason: 'untrusted_issuer' },
    error: { status: 400, error: 'invalid_grant' },
  },
  {
    name: 'expired IdP token',
    token: failure('expired'),
    expect: { outcome: 'failure', reason: 'expired' },
    error: { status: 400, error: 'invalid_grant' },
  },
  {
    name: "the tenant's keys unreachable (R29-1: 503, the token not burned)",
    token: failure('idp_unavailable'),
    expect: { outcome: 'error', reason: 'idp_unavailable' },
    error: { status: 503, error: 'temporarily_unavailable' },
  },
  {
    name: 'replay',
    replayed: true,
    expect: { outcome: 'failure', reason: 'replay' },
    error: { status: 400, error: 'invalid_grant' },
  },
  {
    name: 'replay store fault',
    consumeFails: true,
    expect: { outcome: 'error', reason: 'internal_error' },
    error: { status: 503, error: 'temporarily_unavailable' },
  },
  {
    name: 'device code switched off',
    config: {
      access: { access_group_id: ACCESS, admin_group_id: ADMIN, device_code_enabled: false },
    },
    expect: { outcome: 'denied', reason: 'device_code_disabled' },
    error: { status: 400, error: 'unauthorized_client' },
  },
  {
    name: 'MFA claim missing',
    config: { idp: { ...idpConfig(), require_mfa_claim: true } },
    identity: { amr: ['pwd'] },
    expect: { outcome: 'failure', reason: 'mfa_claim_missing' },
    error: { status: 400, error: 'invalid_grant' },
  },
  {
    name: 'Graph unavailable',
    directory: { kind: 'unavailable', reason: 'timeout' },
    expect: { outcome: 'error', reason: 'idp_unavailable' },
    error: { status: 503, error: 'temporarily_unavailable' },
  },
  {
    name: 'Graph unavailable with overage',
    identity: { groups: { kind: 'overage' } },
    directory: { kind: 'unavailable', reason: 'circuit_open' },
    expect: { outcome: 'error', reason: 'group_overage_unresolved' },
    error: { status: 503, error: 'temporarily_unavailable' },
  },
  {
    name: 'disabled at the IdP',
    directory: { kind: 'disabled' },
    expect: { outcome: 'denied', reason: 'user_disabled' },
    error: { status: 400, error: 'access_denied' },
  },
  {
    name: 'deleted (Graph 404), known user',
    directory: { kind: 'deleted' },
    knownUser: true,
    expect: { outcome: 'denied', reason: 'user_disabled' },
    error: { status: 400, error: 'access_denied' },
  },
  {
    name: 'Entra sessions revoked after the IdP token was issued',
    directory: { ...ok, sessionsValidFrom: new Date(Date.now() + 5_000) },
    expect: { outcome: 'failure', reason: 'expired' },
    error: { status: 400, error: 'invalid_grant' },
  },
  {
    name: 'in no configured group',
    directory: { ...ok, inAccessGroup: false },
    expect: { outcome: 'denied', reason: 'not_in_access_group' },
    error: { status: 400, error: 'access_denied' },
  },
  {
    name: 'admin only, weak flow',
    directory: { ...ok, inAccessGroup: false, inAdminGroup: true },
    expect: { outcome: 'denied', reason: 'admin_requires_strong_flow' },
    error: { status: 400, error: 'access_denied' },
  },
  {
    name: 'admin only, phishing-resistant amr, asks for a user audience',
    body: { ...GRANT, audience: 'model-gateway' },
    identity: { amr: ['fido'] },
    directory: { ...ok, inAccessGroup: false, inAdminGroup: true },
    expect: { outcome: 'denied', reason: 'not_in_access_group' },
    error: { status: 400, error: 'access_denied' },
  },
  {
    name: 'provisioning fault',
    provisionFails: true,
    expect: { outcome: 'error', reason: 'internal_error' },
    error: { status: 503, error: 'temporarily_unavailable' },
  },
  {
    name: 'signing fault',
    mintFails: true,
    expect: { outcome: 'error', reason: 'internal_error' },
    error: { status: 503, error: 'temporarily_unavailable' },
  },
  {
    name: 'success, audit unavailable (fail closed; the success event is spooled)',
    auditFails: true,
    expect: { outcome: 'success' },
    error: { status: 503, error: 'temporarily_unavailable' },
  },
  { name: 'success', expect: { outcome: 'success' } },
];

function idpConfig() {
  return serveConfigInput().idp as Record<string, unknown>;
}

function setUp(s: Scenario) {
  const config = serveConfig({
    env: 'test',
    access: { access_group_id: ACCESS, admin_group_id: ADMIN },
    ...s.config,
  });
  const written: StoredEventInput[] = [];
  const spooled: StoredEventInput[] = [];
  const revokedSessions: string[] = [];
  const counters = { consumed: 0 };
  const writer: AuditWriter = {
    write: (_org, events) => {
      if (s.auditFails === true) return Promise.reject(new AuditUnavailableError('test'));
      written.push(...events);
      return Promise.resolve(
        events.map((e) => ({ event_id: e.event_id, status: 'stored' as const })),
      );
    },
    writeOrSpool: (_org, events) => {
      if (s.auditFails === true) {
        spooled.push(...events);
        return Promise.resolve({ spooled: events.length });
      }
      written.push(...events);
      return Promise.resolve({
        results: events.map((e) => ({ event_id: e.event_id, status: 'stored' as const })),
      });
    },
  };
  const store: SignInStore = {
    consumeIdpToken: () =>
      ++counters.consumed > 0 && s.consumeFails === true
        ? Promise.reject(new Error('db down'))
        : Promise.resolve(s.replayed !== true),
    findUser: () =>
      Promise.resolve(
        s.knownUser === true
          ? { id: '0192f0a0-7b3c-7d4e-8f00-0000000000a1', status: 'active' as const }
          : undefined,
      ),
    revokeUser: () => Promise.resolve(1),
    revokeSession: (sid) => {
      revokedSessions.push(sid);
      return Promise.resolve(true);
    },
    groupsNeedingNames: () => Promise.resolve([]),
    provision: () =>
      s.provisionFails === true
        ? Promise.reject(new Error('db down'))
        : Promise.resolve({
            userId: '0192f0a0-7b3c-7d4e-8f00-0000000000a1',
            created: true,
            changedAttributes: [],
            added: [ACCESS],
            removed: [],
            sessionId: '0192f0a0-7b3c-7d4e-8f00-0000000000b1',
            refreshToken: `rly_rt_${'a'.repeat(43)}`,
          }),
  };
  const env: ExchangeEnv = {
    config,
    policyVersion: policyVersion(config.access),
    directory: { check: () => Promise.resolve(s.directory ?? ok) },
    store,
    writer,
    hmac: { of: (v) => Promise.resolve(v === undefined ? undefined : 'f'.repeat(64)) },
    mint: () =>
      s.mintFails === true ? Promise.reject(new Error('transit down')) : Promise.resolve('a.b.c'),
    metrics: createMemoryMetrics(),
    logger: silentLogger,
    validator: {
      validateAccessToken: () =>
        Promise.resolve(s.token ?? { ok: true, identity: identity(s.identity) }),
    },
  };
  return { env, written, spooled, revokedSessions, counters };
}

describe('token exchange: every exit writes exactly one auth.sign_in (AC-4)', () => {
  it('covers every sign-in reason the exchange can end with', () => {
    const covered = new Set(
      SCENARIOS.flatMap((s) =>
        s.expect !== 'none' && s.expect.reason !== undefined ? [s.expect.reason] : [],
      ),
    );
    // Flow B's own reasons are enumerated with its routes; client reports by their route.
    const flowBOnly: SignInReason[] = [
      'browser_binding_failed',
      'code_not_redeemed',
      'loopback_ip_mismatch',
      'idp_error',
    ];
    for (const reason of Object.keys(SIGN_IN_REASON_OUTCOMES) as SignInReason[]) {
      if (!flowBOnly.includes(reason)) expect(covered, reason).toContain(reason);
    }
  });

  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const { env, written, spooled, revokedSessions, counters } = setUp(scenario);
      let thrown: unknown;
      let result;
      try {
        result = await tokenExchangeGrant(env, scenario.body ?? GRANT, {
          traceId: '0af7651916cd43dd8448eb211c80319c',
          clientIp: '127.0.0.1',
          userAgent: 'ralysa-cli/0.0.0',
        });
      } catch (error) {
        thrown = error;
      }
      const all = [...written, ...spooled];
      const signIns = all.filter((e) => e.action === 'auth.sign_in');
      if (scenario.expect === 'none') {
        expect(signIns).toHaveLength(0);
      } else {
        expect(signIns).toHaveLength(1);
        expect(signIns[0]).toMatchObject({
          outcome: scenario.expect.outcome,
          reason_code: scenario.expect.reason ?? null,
          surface: 'cli',
          policy_version: env.policyVersion,
        });
        expect(signIns[0]?.details).toMatchObject({
          flow: 'idp_device',
          client_ip: '127.0.0.1',
          client_type: 'public',
          reported_by: 'server',
        });
      }
      if (scenario.error === undefined) {
        expect(thrown).toBeUndefined();
        expect(result).toMatchObject({ token_type: 'Bearer', access_token: 'a.b.c' });
      } else {
        expect(thrown).toBeInstanceOf(OAuthProblem);
        const problem = thrown as OAuthProblem;
        expect({ status: problem.status, error: problem.body.error }).toEqual(scenario.error);
        if (scenario.expect !== 'none' && scenario.expect.reason !== undefined) {
          expect(problem.body.ralysa_error?.code).toBe(scenario.expect.reason);
        }
      }
      // Events never carry the IdP token.
      expect(JSON.stringify(all)).not.toContain(GRANT.subject_token);
      if (scenario.token !== undefined) {
        expect(signIns[0]?.details).toMatchObject({
          identifier_verified: false,
          attempted_identifier_hmac: 'f'.repeat(64),
        });
        expect(JSON.stringify(all)).not.toContain('someone@contoso.example');
      }
      if (scenario.knownUser === true && scenario.directory?.kind === 'deleted') {
        expect(all.map((e) => e.action)).toEqual(['auth.session.revoked', 'auth.sign_in']);
      }
      if (scenario.mintFails === true || scenario.auditFails === true) {
        expect(revokedSessions).toEqual(['0192f0a0-7b3c-7d4e-8f00-0000000000b1']);
      }
      if (scenario.mintFails === true) {
        // What provisioning did, and the revocation, are recorded with the refusal (R29-2).
        expect(all.map((e) => e.action)).toEqual([
          'directory.user.provisioned',
          'directory.group_membership.changed',
          'auth.session.revoked',
          'auth.sign_in',
        ]);
        expect(all[2]?.details).toMatchObject({ cause: 'internal_error' });
      }
      if (scenario.token?.ok === false) {
        // Refused before the replay key: the IdP token isn't burned, so a retry can succeed.
        expect(counters.consumed).toBe(0);
      }
      if (scenario.auditFails === true) {
        expect(spooled.map((e) => e.action)).toEqual([
          'directory.user.provisioned',
          'directory.group_membership.changed',
          'auth.sign_in',
          'auth.session.revoked',
        ]);
        expect(spooled.at(-1)?.details).toMatchObject({ cause: 'audit_unavailable' });
      }
    });
  }

  it('a second record for one attempt is a programming error', async () => {
    const { env } = setUp({ name: 'x', expect: 'none' });
    const attempt = new SignInAttempt(env, {
      flow: 'idp_device',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      clientIp: '127.0.0.1',
      userAgent: undefined,
      deviceLabel: undefined,
    });
    await attempt.refuse('replay');
    await expect(attempt.refuse('replay')).rejects.toBeInstanceOf(SignInRecordedTwiceError);
    expect(() => {
      attempt.claimSuccess();
    }).toThrow(SignInRecordedTwiceError);
  });

  it('records the ipaddr mismatch without denying (SEC-F002-05)', async () => {
    const { env, written } = setUp({
      name: 'x',
      identity: { ipaddr: '203.0.113.9' },
      expect: 'none',
    });
    await tokenExchangeGrant(env, GRANT, {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      clientIp: '::ffff:127.0.0.1',
    });
    const signIn = written.find((e) => e.action === 'auth.sign_in');
    expect(signIn?.outcome).toBe('success');
    expect(signIn?.details).toMatchObject({ idp_ipaddr: '203.0.113.9', ip_mismatch: true });
    expect(
      (env.metrics as ReturnType<typeof createMemoryMetrics>).counter(
        'auth_device_ip_mismatch_total',
      ),
    ).toBe(1);
  });

  it('withholds the admin role on a weak flow for a user in both groups', async () => {
    const { env, written } = setUp({
      name: 'x',
      directory: { ...ok, inAdminGroup: true },
      expect: 'none',
    });
    await tokenExchangeGrant(env, GRANT, {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      clientIp: '127.0.0.1',
    });
    expect(written.find((e) => e.action === 'auth.sign_in')?.details).toMatchObject({
      roles: ['user'],
      admin_role_withheld: true,
    });
  });

  it('strips bidi and zero-width characters from the device label, keeping Arabic (SEC-F002-30)', async () => {
    const { env, written } = setUp({ name: 'x', expect: 'none' });
    await tokenExchangeGrant(
      env,
      { ...GRANT, device_label: '\u202eحاسوب\u200b فاطمة\u200f\u0007' },
      { traceId: '0af7651916cd43dd8448eb211c80319c', clientIp: '127.0.0.1' },
    );
    expect(written.find((e) => e.action === 'auth.sign_in')?.details.device_label).toBe(
      'حاسوب فاطمة\u200f',
    );
  });
});
