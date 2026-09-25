// Sign-in access decision (F-002 design §6.1, §6.3; SR-06; D-11, D-23; SEC-F002-06; [AR-4]).
// Phase 0 has no Cedar PDP: the two configured groups are the whole policy. The function still
// takes and returns the ADR-0011 shapes (principal/action/resource/context → {decision,
// obligations, reasons[], contributing_profiles[], policy_version}), so F-006 can replace the body
// with a PDP call behind the same signature.
//
// Group membership is what Microsoft Graph reported for the two configured object ids (D-36),
// never the token's `groups` claim or a display name.
//   - `user` role: member of the access group.
//   - `platform_admin` role: member of the admin group AND a strong sign-in: flow B
//     (`loopback_pkce`), or `acrs` containing `access.admin_auth_context`, or `amr` containing a
//     value in `access.phishing_resistant_amr`.
//   - An admin on a weak sign-in who is also in the access group gets `user` only
//     (`admin_role_withheld`); an admin-only user is denied `admin_requires_strong_flow`.
//   - No role → denied `not_in_access_group`.
import type { Audience } from '@ralysa/protocol/auth';
import type { ServeConfig } from '../config/schema.js';
import type { SessionRole } from './sessions.js';

export type SignInFlow = 'idp_device' | 'loopback_pkce';

export interface SignInPolicyInput {
  principal: {
    idpSubject: string;
    /** From Graph checkMemberGroups (D-36). */
    groups: { access: boolean; admin: boolean };
  };
  action: 'auth.sign_in';
  resource: { type: 'organization'; id: string };
  context: { flow: SignInFlow; amr: readonly string[]; acrs: readonly string[] };
}

export interface SignInDecision {
  decision: 'allow' | 'deny';
  /** None in Phase 0 (ADR-0011 output contract). */
  obligations: [];
  /** Reason codes: the deny reason, or `admin_role_withheld` on an allow. */
  reasons: ('not_in_access_group' | 'admin_requires_strong_flow' | 'admin_role_withheld')[];
  contributing_profiles: [];
  policy_version: string;
  /** Session roles granted (Phase 0 addition; empty on deny). */
  roles: SessionRole[];
}

export function isStrongSignIn(
  access: ServeConfig['access'],
  context: SignInPolicyInput['context'],
): boolean {
  if (context.flow === 'loopback_pkce') return true;
  if (access.admin_auth_context !== undefined && context.acrs.includes(access.admin_auth_context)) {
    return true;
  }
  return context.amr.some((value) => access.phishing_resistant_amr.includes(value));
}

export function decideSignIn(
  access: ServeConfig['access'],
  policyVersion: string,
  input: SignInPolicyInput,
): SignInDecision {
  const { groups } = input.principal;
  const strong = isStrongSignIn(access, input.context);
  const roles: SessionRole[] = [];
  if (groups.access) roles.push('user');
  if (groups.admin && strong) roles.push('platform_admin');
  const base = {
    obligations: [] as [],
    contributing_profiles: [] as [],
    policy_version: policyVersion,
  };
  if (roles.length === 0) {
    return {
      ...base,
      decision: 'deny',
      reasons: [groups.admin ? 'admin_requires_strong_flow' : 'not_in_access_group'],
      roles: [],
    };
  }
  return {
    ...base,
    decision: 'allow',
    reasons: groups.admin && !strong ? ['admin_role_withheld'] : [],
    roles,
  };
}

/** §6.1 audience minting: only `control-plane` for a session without the `user` role. */
export function audienceAllowed(roles: readonly SessionRole[], audience: Audience): boolean {
  return audience === 'control-plane' || roles.includes('user');
}
