// AC-4 completeness (F-002 design §6.4): every exit of the token-exchange grant is enumerated and
// each writes EXACTLY ONE `auth.sign_in` event with the right outcome and reason, and answers
// the right OAuth error. Hermetic: the IdP validator, directory, store, writer and signer are
// fakes, so each exit is reached on purpose.
import { SIGN_IN_REASON_OUTCOMES, type SignInReason } from '@ralysa/protocol/auth';
import { describe, expect, it } from 'vitest';
import type { StoredEventInput } from '../src/audit/columns.js';
import { AuditUnavailableError, type AuditWriter } from '../src/audit/writer.js';
import type { DirectoryCheck } from '../src/auth/directory-port.js';
import { createHash } from 'node:crypto';
import { type FlowBEnv, bindingCookie, completeCallback, s256 } from '../src/auth/flow-b.js';
import { authorizationCodeGrant } from '../src/auth/grants/authorization-code.js';
import { type ExchangeEnv, tokenExchangeGrant } from '../src/auth/grants/token-exchange.js';
import type { RedeemResult } from '../src/auth/idp/oidc-client.js';
import type { CodeRedemption } from '../src/auth/sessions.js';
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
    directory: { ...ok, sessionsValidFrom: new Date(Date.now() + 3_600_000) },
    expect: { outcome: 'failure', reason: 'expired' },
    error: { status: 400, error: 'invalid_grant' },
  },
  {
    // R29-n7 (unit exit, R29 follow-up): a known user is also revoked, and that is recorded.
    name: 'Entra sessions revoked after the IdP token was issued, known user',
    directory: { ...ok, sessionsValidFrom: new Date(Date.now() + 3_600_000) },
    knownUser: true,
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
    graphCheckTime: () => Promise.resolve(new Date()),
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
            roleSkew: [],
            sessionId: '0192f0a0-7b3c-7d4e-8f00-0000000000b1',
            refreshToken: `rly_rt_${'a'.repeat(43)}`,
          }),
    ...unusedFlowB,
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
      validateIdToken: () => Promise.reject(new Error('not flow B')),
    },
  };
  return { env, written, spooled, revokedSessions, counters };
}

const unused = () => Promise.reject(new Error('not used by this flow'));
const unusedFlowB = {
  saveAuthRequest: unused,
  consumeAuthRequest: unused,
  createCode: unused,
  redeemCode: unused,
  sessionOwner: unused,
  activateSession: unused,
};

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
      if (
        scenario.knownUser === true &&
        scenario.directory?.kind === 'ok' &&
        scenario.directory.sessionsValidFrom !== null
      ) {
        expect(all.map((e) => e.action)).toEqual(['auth.session.revoked', 'auth.sign_in']);
        expect(all[0]?.details).toMatchObject({ cause: 'idp_sessions_revoked' });
        expect(signIns[0]?.details).toMatchObject({ cause: 'idp_sessions_revoked' });
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

// --- Flow B -------------------------------------------------------------------------------------
// The callback and the code redemption together: an attempt is recorded once, either at the
// callback (a refusal) or at redemption (success or a refusal). An allowed callback records
// nothing; its attempt ends at redemption, or with `code_not_redeemed` from cleanup (T08).

const SID = '0192f0a0-7b3c-7d4e-8f00-0000000000b2';
const USER = '0192f0a0-7b3c-7d4e-8f00-0000000000a2';
const VERIFIER = 'v'.repeat(43);
const REDIRECT = 'http://127.0.0.1:49152/callback';
const BINDING = 'binding-cookie-value';

interface FlowBScenario {
  name: string;
  /** The callback's query. */
  query?: Record<string, string>;
  requestFound?: boolean;
  requestLive?: boolean;
  binding?: string | undefined;
  redeem?: RedeemResult;
  idToken?: IdpTokenResult;
  identity?: Partial<IdpIdentity>;
  config?: Record<string, unknown>;
  directory?: DirectoryCheck;
  createCodeFails?: boolean;
  expectCallback:
    | { kind: 'invalid' }
    | { kind: 'redirect'; error?: string; description?: string; code?: boolean };
  /** auth.sign_in written at the callback. */
  callbackEvent?: { outcome: string; reason: SignInReason };
}

const CALLBACK_SCENARIOS: FlowBScenario[] = [
  {
    name: 'unknown state (not an attempt)',
    requestFound: false,
    expectCallback: { kind: 'invalid' },
  },
  {
    name: 'expired request (not an attempt)',
    requestLive: false,
    expectCallback: { kind: 'redirect', error: 'invalid_request' },
  },
  {
    name: 'no browser-binding cookie',
    binding: undefined,
    expectCallback: { kind: 'invalid' },
    callbackEvent: { outcome: 'failure', reason: 'browser_binding_failed' },
  },
  {
    name: 'another browser-binding cookie',
    binding: 'someone-else',
    expectCallback: { kind: 'invalid' },
    callbackEvent: { outcome: 'failure', reason: 'browser_binding_failed' },
  },
  {
    name: 'IdP error',
    query: { error: 'access_denied' },
    expectCallback: { kind: 'redirect', error: 'access_denied', description: 'idp_error' },
    callbackEvent: { outcome: 'failure', reason: 'idp_error' },
  },
  {
    name: 'IdP token endpoint unreachable',
    redeem: { kind: 'unavailable', reason: 'network' },
    expectCallback: {
      kind: 'redirect',
      error: 'temporarily_unavailable',
      description: 'idp_unavailable',
    },
    callbackEvent: { outcome: 'error', reason: 'idp_unavailable' },
  },
  {
    name: 'IdP response rejected (nonce, state, signature)',
    redeem: { kind: 'rejected', reason: 'OAUTH_JWT_CLAIM_COMPARISON_FAILED' },
    expectCallback: { kind: 'redirect', error: 'access_denied', description: 'invalid_idp_token' },
    callbackEvent: { outcome: 'failure', reason: 'invalid_idp_token' },
  },
  {
    name: 'ID token from another tenant',
    idToken: { ok: false, reason: 'untrusted_issuer', check: 'tid', unverifiedIdentifier: 'x@y' },
    expectCallback: { kind: 'redirect', error: 'access_denied', description: 'untrusted_issuer' },
    callbackEvent: { outcome: 'failure', reason: 'untrusted_issuer' },
  },
  {
    name: 'MFA claim missing',
    config: {
      idp: { ...(serveConfigInput().idp as Record<string, unknown>), require_mfa_claim: true },
    },
    identity: { amr: ['pwd'] },
    expectCallback: { kind: 'redirect', error: 'access_denied', description: 'mfa_claim_missing' },
    callbackEvent: { outcome: 'failure', reason: 'mfa_claim_missing' },
  },
  {
    name: 'Graph unavailable',
    directory: { kind: 'unavailable', reason: 'timeout' },
    expectCallback: {
      kind: 'redirect',
      error: 'temporarily_unavailable',
      description: 'idp_unavailable',
    },
    callbackEvent: { outcome: 'error', reason: 'idp_unavailable' },
  },
  {
    name: 'not in the access group',
    directory: { ...ok, inAccessGroup: false },
    expectCallback: {
      kind: 'redirect',
      error: 'access_denied',
      description: 'not_in_access_group',
    },
    callbackEvent: { outcome: 'denied', reason: 'not_in_access_group' },
  },
  {
    name: 'code creation fault',
    createCodeFails: true,
    expectCallback: {
      kind: 'redirect',
      error: 'temporarily_unavailable',
      description: 'internal_error',
    },
    callbackEvent: { outcome: 'error', reason: 'internal_error' },
  },
  {
    name: 'allowed: a code, nothing recorded yet',
    expectCallback: { kind: 'redirect', code: true },
  },
  {
    name: 'admin only is allowed on flow B (a strong flow)',
    directory: { ...ok, inAccessGroup: false, inAdminGroup: true },
    expectCallback: { kind: 'redirect', code: true },
  },
];

interface RedeemScenario {
  name: string;
  body?: Record<string, string>;
  redemption?: CodeRedemption;
  clientIp?: string;
  config?: Record<string, unknown>;
  activates?: boolean;
  mintFails?: boolean;
  auditFails?: boolean;
  expect: { outcome: string; reason?: SignInReason; ipMismatch?: boolean } | 'none';
  error?: { status: number; error: string };
  /** Other actions expected (reuse). */
  actions?: string[];
}

const okRedemption: CodeRedemption = {
  kind: 'ok',
  sessionId: SID,
  clientId: 'ralysa-cli',
  redirectUri: REDIRECT,
  codeChallenge: s256(VERIFIER),
  callbackIp: '127.0.0.1',
  signIn: {
    authorize_ip: '127.0.0.9',
    amr: ['pwd', 'mfa'],
    acr: [],
    idp_ipaddr: '127.0.0.1',
    roles: ['user'],
    admin_role_withheld: false,
  },
};

const REDEEM_SCENARIOS: RedeemScenario[] = [
  {
    name: 'malformed request (not an attempt)',
    body: { grant_type: 'authorization_code', client_id: 'ralysa-cli', code: 'x' },
    expect: 'none',
    error: { status: 400, error: 'invalid_request' },
  },
  {
    name: 'unknown or expired code (cleanup records an unredeemed one)',
    redemption: { kind: 'invalid' },
    expect: 'none',
    error: { status: 400, error: 'invalid_grant' },
  },
  {
    name: 'wrong verifier or redirect URI: not consumed, not an attempt',
    redemption: { kind: 'mismatch' },
    expect: 'none',
    error: { status: 400, error: 'invalid_grant' },
  },
  {
    name: 'second redemption (reuse): the session is revoked',
    redemption: { kind: 'reused', sessionId: SID, revoked: true },
    expect: 'none',
    error: { status: 400, error: 'invalid_grant' },
    actions: ['auth.token.reuse_detected', 'auth.session.revoked'],
  },
  {
    name: 'redeemed from another IP (deny)',
    clientIp: '203.0.113.7',
    expect: { outcome: 'denied', reason: 'loopback_ip_mismatch', ipMismatch: true },
    error: { status: 400, error: 'access_denied' },
    actions: ['auth.session.revoked', 'auth.sign_in'],
  },
  {
    name: 'redeemed from another IP (alert mode)',
    clientIp: '203.0.113.7',
    config: {
      access: { access_group_id: ACCESS, admin_group_id: ADMIN, loopback_ip_mismatch: 'alert' },
    },
    expect: { outcome: 'success', ipMismatch: true },
  },
  {
    name: 'stored callback facts malformed (review of #30): internal_error, nothing guessed',
    redemption: { ...okRedemption, signIn: { roles: 'everything' } },
    expect: { outcome: 'error', reason: 'internal_error' },
    error: { status: 503, error: 'temporarily_unavailable' },
  },
  {
    name: 'session no longer pending',
    activates: false,
    expect: { outcome: 'failure', reason: 'expired' },
    error: { status: 400, error: 'invalid_grant' },
  },
  {
    name: 'signing fault',
    mintFails: true,
    expect: { outcome: 'error', reason: 'internal_error' },
    error: { status: 503, error: 'temporarily_unavailable' },
  },
  {
    name: 'audit unavailable (fail closed; the success event is spooled)',
    auditFails: true,
    expect: { outcome: 'success' },
    error: { status: 503, error: 'temporarily_unavailable' },
  },
  { name: 'success', expect: { outcome: 'success', ipMismatch: false } },
];

function setUpFlowB(input: {
  config?: Record<string, unknown>;
  directory?: DirectoryCheck;
  auditFails?: boolean;
  mintFails?: boolean;
}) {
  const base = setUp({
    name: 'flow B',
    expect: 'none',
    ...(input.config === undefined ? {} : { config: input.config }),
    ...(input.directory === undefined ? {} : { directory: input.directory }),
    ...(input.auditFails === undefined ? {} : { auditFails: input.auditFails }),
    ...(input.mintFails === undefined ? {} : { mintFails: input.mintFails }),
  });
  return base;
}

describe('flow B: the callback records a refusal once, or nothing until redemption (AC-4)', () => {
  it('covers every flow-B-only sign-in reason (callback and redemption together)', () => {
    const covered = new Set([
      ...CALLBACK_SCENARIOS.flatMap((s) =>
        s.callbackEvent === undefined ? [] : [s.callbackEvent.reason],
      ),
      ...REDEEM_SCENARIOS.flatMap((s) =>
        s.expect === 'none' || s.expect.reason === undefined ? [] : [s.expect.reason],
      ),
    ]);
    for (const reason of ['browser_binding_failed', 'loopback_ip_mismatch', 'idp_error'] as const) {
      expect(covered).toContain(reason);
    }
  });

  for (const scenario of CALLBACK_SCENARIOS) {
    it(scenario.name, async () => {
      const { env, written, revokedSessions } = setUpFlowB({
        ...(scenario.config === undefined ? {} : { config: scenario.config }),
        ...(scenario.directory === undefined ? {} : { directory: scenario.directory }),
      });
      const created: unknown[] = [];
      env.store = {
        ...env.store,
        consumeAuthRequest: () =>
          Promise.resolve(
            scenario.requestFound === false
              ? undefined
              : {
                  stateHash: Buffer.alloc(32),
                  browserBindingHash: createHash('sha256').update(BINDING).digest(),
                  clientRedirectUri: REDIRECT,
                  clientState: 'client-state-0123456789',
                  clientCodeChallenge: s256(VERIFIER),
                  authorizeIp: '127.0.0.9',
                  idpCodeVerifier: 'idp-verifier',
                  idpNonce: 'idp-nonce',
                  live: scenario.requestLive ?? true,
                },
          ),
        provision: () =>
          Promise.resolve({
            userId: USER,
            created: false,
            changedAttributes: [],
            added: [],
            removed: [],
            roleSkew: [],
            sessionId: SID,
          }),
        createCode: (row) => {
          if (scenario.createCodeFails === true) return Promise.reject(new Error('db down'));
          created.push(row);
          return Promise.resolve();
        },
      };
      const flowB: FlowBEnv = {
        ...env,
        oidc: {
          authorizationUrl: () => Promise.resolve('https://idp.example/authorize'),
          redeem: () =>
            Promise.resolve(scenario.redeem ?? { kind: 'ok', idToken: 'id.token.value' }),
        },
        validator: {
          ...env.validator,
          validateIdToken: () =>
            Promise.resolve(
              scenario.idToken ?? { ok: true, identity: identity(scenario.identity) },
            ),
        },
      };
      const outcome = await completeCallback(
        flowB,
        { state: 'rts-state', code: 'idp-code', ...scenario.query },
        {
          clientIp: '127.0.0.1',
          traceId: '0af7651916cd43dd8448eb211c80319c',
          userAgent: 'Mozilla/5.0',
          cookie: (name) =>
            name === bindingCookie(flowB.config, 'rts-state').name
              ? 'binding' in scenario
                ? scenario.binding
                : BINDING
              : undefined,
          rawQuery: '?state=rts-state&code=idp-code',
        },
      );
      const signIns = written.filter((e) => e.action === 'auth.sign_in');
      // The cookie is cleared only when the request was found (another flow's survives).
      expect(outcome.clearCookie).toBe(
        scenario.requestFound === false ? undefined : bindingCookie(flowB.config, 'rts-state').name,
      );
      if (scenario.callbackEvent === undefined) {
        expect(signIns).toHaveLength(0);
      } else {
        expect(signIns).toHaveLength(1);
        // The authorize IP travels with the attempt (R30-2).
        expect(signIns[0]?.details).toMatchObject({ authorize_ip: '127.0.0.9' });
        expect(signIns[0]).toMatchObject({
          outcome: scenario.callbackEvent.outcome,
          reason_code: scenario.callbackEvent.reason,
          details: { flow: 'loopback_pkce' },
        });
      }
      const expected = scenario.expectCallback;
      expect(outcome.kind).toBe(expected.kind);
      if (outcome.kind === 'redirect' && expected.kind === 'redirect') {
        const url = new URL(outcome.location);
        expect(url.origin + url.pathname).toBe(REDIRECT);
        expect(url.searchParams.get('state')).toBe('client-state-0123456789');
        expect(url.searchParams.get('error') ?? undefined).toBe(expected.error);
        expect(url.searchParams.get('error_description') ?? undefined).toBe(expected.description);
        expect(url.searchParams.get('code') !== null).toBe(expected.code === true);
        if (expected.code === true) {
          expect(url.searchParams.get('code')).toMatch(/^rly_ac_[A-Za-z0-9_-]{43}$/);
          expect(created).toHaveLength(1);
          expect(created[0]).toMatchObject({
            sessionId: SID,
            redirectUri: REDIRECT,
            codeChallenge: s256(VERIFIER),
            callbackIp: '127.0.0.1',
            ttlSeconds: 60,
            signIn: expect.objectContaining({ authorize_ip: '127.0.0.9' }) as unknown,
          });
        }
      }
      if (scenario.createCodeFails === true) expect(revokedSessions).toEqual([SID]);
    });
  }
});

describe('flow B: code redemption writes exactly one auth.sign_in (AC-4)', () => {
  for (const scenario of REDEEM_SCENARIOS) {
    it(scenario.name, async () => {
      const { env, written, spooled, revokedSessions } = setUpFlowB({
        ...(scenario.config === undefined ? {} : { config: scenario.config }),
        ...(scenario.auditFails === undefined ? {} : { auditFails: scenario.auditFails }),
        ...(scenario.mintFails === undefined ? {} : { mintFails: scenario.mintFails }),
      });
      env.store = {
        ...env.store,
        redeemCode: () => Promise.resolve(scenario.redemption ?? okRedemption),
        sessionOwner: () =>
          Promise.resolve({ userId: USER, idpSubject: OID, roles: ['user'], status: 'pending' }),
        activateSession: () =>
          Promise.resolve(scenario.activates === false ? undefined : `rly_rt_${'b'.repeat(43)}`),
      };
      let thrown: unknown;
      let result;
      try {
        result = await authorizationCodeGrant(
          env,
          scenario.body ?? {
            grant_type: 'authorization_code',
            client_id: 'ralysa-cli',
            code: `rly_ac_${'c'.repeat(43)}`,
            redirect_uri: REDIRECT,
            code_verifier: VERIFIER,
          },
          {
            traceId: '0af7651916cd43dd8448eb211c80319c',
            clientIp: scenario.clientIp ?? '127.0.0.1',
          },
        );
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
          session_id: SID,
          details: {
            flow: 'loopback_pkce',
            callback_ip: '127.0.0.1',
            ...(scenario.redemption?.kind === 'ok' ? {} : { authorize_ip: '127.0.0.9' }),
          },
        });
        if (scenario.expect.ipMismatch !== undefined) {
          expect(signIns[0]?.details.ip_mismatch).toBe(scenario.expect.ipMismatch);
        }
      }
      if (scenario.actions !== undefined) {
        expect(all.map((e) => e.action)).toEqual(scenario.actions);
      }
      if (scenario.error === undefined) {
        expect(thrown).toBeUndefined();
        expect(result).toMatchObject({
          token_type: 'Bearer',
          refresh_token: `rly_rt_${'b'.repeat(43)}`,
        });
      } else {
        expect(thrown).toBeInstanceOf(OAuthProblem);
        const problem = thrown as OAuthProblem;
        expect({ status: problem.status, error: problem.body.error }).toEqual(scenario.error);
      }
      if (scenario.expect !== 'none' && scenario.expect.reason === 'loopback_ip_mismatch') {
        expect(revokedSessions).toEqual([SID]);
      }
      if (scenario.mintFails === true || scenario.auditFails === true) {
        expect(revokedSessions).toEqual([SID]);
      }
    });
  }
});
