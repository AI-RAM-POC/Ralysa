// identity-mapping.ts (F-002 design §6.1; D-23; SEC-F002-06; [AR-4]) and the display-text
// sanitiser (SEC-F002-30).
import { describe, expect, it } from 'vitest';
import { sanitizeDisplayText } from '../src/auth/display-text.js';
import {
  audienceAllowed,
  decideSignIn,
  isStrongSignIn,
  type SignInPolicyInput,
} from '../src/auth/identity-mapping.js';
import { policyVersion } from '../src/auth/policy-version.js';
import { serveConfig } from './fixtures/serve-config.js';

const access = serveConfig({
  access: {
    access_group_id: '4f1c2e3d-0000-4000-8000-0000000000d1',
    admin_group_id: '4f1c2e3d-0000-4000-8000-0000000000d2',
    admin_auth_context: 'c1',
  },
}).access;
const version = policyVersion(access);

const input = (
  groups: { access: boolean; admin: boolean },
  context: Partial<SignInPolicyInput['context']> = {},
): SignInPolicyInput => ({
  principal: { idpSubject: '6a0e5a4e-1111-4222-8333-444455556666', groups },
  action: 'auth.sign_in',
  resource: { type: 'organization', id: '0192f0a0-7b3c-7d4e-8f00-00000000000f' },
  context: { flow: 'idp_device', amr: ['pwd', 'mfa'], acrs: [], ...context },
});

describe('sign-in decision (ADR-0011 shapes)', () => {
  it('returns the ADR-0011 output contract with the Phase 0 policy version', () => {
    const decision = decideSignIn(access, version, input({ access: true, admin: false }));
    expect(decision).toEqual({
      decision: 'allow',
      obligations: [],
      reasons: [],
      contributing_profiles: [],
      policy_version: version,
      roles: ['user'],
    });
    expect(version).toMatch(/^p0-static:[0-9a-f]{12}$/);
  });

  it.each([
    // groups, context, decision, roles, reasons
    [{ access: false, admin: false }, {}, 'deny', [], ['not_in_access_group']],
    [{ access: false, admin: true }, {}, 'deny', [], ['admin_requires_strong_flow']],
    [{ access: true, admin: true }, {}, 'allow', ['user'], ['admin_role_withheld']],
    [
      { access: true, admin: true },
      { flow: 'loopback_pkce' },
      'allow',
      ['user', 'platform_admin'],
      [],
    ],
    [{ access: false, admin: true }, { flow: 'loopback_pkce' }, 'allow', ['platform_admin'], []],
    [{ access: false, admin: true }, { amr: ['fido'] }, 'allow', ['platform_admin'], []],
    [{ access: false, admin: true }, { amr: ['wia'] }, 'allow', ['platform_admin'], []],
    [{ access: false, admin: true }, { acrs: ['c1'] }, 'allow', ['platform_admin'], []],
    [{ access: false, admin: true }, { acrs: ['c2'] }, 'deny', [], ['admin_requires_strong_flow']],
  ] as const)('groups %o, context %o → %s %o', (groups, context, decision, roles, reasons) => {
    const result = decideSignIn(access, version, input(groups, context));
    expect(result.decision).toBe(decision);
    expect(result.roles).toEqual(roles);
    expect(result.reasons).toEqual(reasons);
  });

  it('a strong flow needs flow B, the admin auth context or phishing-resistant amr', () => {
    expect(isStrongSignIn(access, input({ access: true, admin: true }).context)).toBe(false);
    const noContext = serveConfig({
      access: {
        access_group_id: '4f1c2e3d-0000-4000-8000-0000000000d1',
        admin_group_id: '4f1c2e3d-0000-4000-8000-0000000000d2',
      },
    }).access;
    // Without an admin auth context configured, acrs alone is never strong.
    expect(isStrongSignIn(noContext, { flow: 'idp_device', amr: [], acrs: ['c1'] })).toBe(false);
  });

  it('only control-plane tokens for a session without the user role (§6.1)', () => {
    expect(audienceAllowed(['platform_admin'], 'control-plane')).toBe(true);
    expect(audienceAllowed(['platform_admin'], 'model-gateway')).toBe(false);
    expect(audienceAllowed(['user'], 'model-gateway')).toBe(true);
  });
});

describe('untrusted display text (SEC-F002-30)', () => {
  const RLE = String.fromCodePoint(0x202b);
  const RLO = String.fromCodePoint(0x202e);
  const LRI = String.fromCodePoint(0x2066);
  const PDI = String.fromCodePoint(0x2069);
  const ZWSP = String.fromCodePoint(0x200b);
  const ZWJ = String.fromCodePoint(0x200d);
  const BOM = String.fromCodePoint(0xfeff);
  const RLM = String.fromCodePoint(0x200f);
  const LRM = String.fromCodePoint(0x200e);
  const ALM = String.fromCodePoint(0x061c);

  it('strips controls, bidi embeddings, overrides, isolates, ZWSP, word joiner and BOM', () => {
    const WJ = String.fromCodePoint(0x2060);
    expect(
      sanitizeDisplayText(
        `${RLO}lap${ZWSP}top${String.fromCodePoint(7)}${LRI}x${PDI}${RLE}${WJ}${BOM}\u0085`,
        64,
      ),
    ).toBe('laptopx');
  });

  it('keeps ZWNJ in a Persian name and ZWJ in an emoji sequence (review of #29)', () => {
    const ZWNJ = String.fromCodePoint(0x200c);
    const persian = `\u0645\u06cc${ZWNJ}\u062e\u0648\u0627\u0647\u0645 \u0632\u0647\u0631\u0627`;
    expect(sanitizeDisplayText(persian, 64)).toBe(persian);
    const family = `\u{1F469}${ZWJ}\u{1F467}`;
    expect(sanitizeDisplayText(`laptop ${family}`, 64)).toBe(`laptop ${family}`);
  });

  it('keeps Arabic with harakat and the RLM/LRM/ALM marks, unnormalised', () => {
    const arabic = `فاطِمَة الزَّهْراء${RLM}${LRM}${ALM}`;
    expect(sanitizeDisplayText(arabic, 64)).toBe(arabic);
    expect(
      Buffer.compare(Buffer.from(sanitizeDisplayText(arabic, 64) ?? ''), Buffer.from(arabic)),
    ).toBe(0);
  });

  it('truncates by code points and drops an empty result', () => {
    expect(sanitizeDisplayText('abcdef', 3)).toBe('abc');
    expect(sanitizeDisplayText(`${ZWSP}${RLO}`, 10)).toBeUndefined();
    expect(sanitizeDisplayText(undefined, 10)).toBeUndefined();
  });
});
