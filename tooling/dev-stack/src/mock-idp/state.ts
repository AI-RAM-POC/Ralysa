// The mock IdP's mutable state (F-002 design §8.3): users, groups, the RTS client's valid
// secrets and the Graph fault toggle. The test-control API and the in-process handle both change
// it through these functions, so the two can't disagree.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type MockGroup, type MockUser, buildFixtures } from './fixtures.ts';

export type GraphFault =
  | { mode: 'none'; latencyMs?: number }
  /** Every Graph call answers `status` (e.g. 500, 503, 429) after `latencyMs`. */
  | { mode: 'error'; status: number; latencyMs?: number }
  /** Every Graph call hangs until the client gives up. */
  | { mode: 'hang' };

export interface UserPatch {
  enabled?: boolean;
  deletedInGraph?: boolean;
  groups?: string[];
  groupClaimOverride?: string[] | null;
  amr?: string[];
  acrs?: string[] | null;
  ipaddr?: string | null;
  displayName?: string;
}

export class UnknownUserError extends Error {
  constructor(username: string) {
    super(`unknown mock user ${username}`);
    this.name = 'UnknownUserError';
  }
}

export interface MockIdpState {
  users: Map<string, MockUser>;
  groups: Map<string, MockGroup>;
  graphFault: GraphFault;
  secrets: Set<string>;
}

export const newClientSecret = (): string => randomBytes(32).toString('base64url');

export function createState(options: {
  accessGroupId: string;
  adminGroupId: string;
}): MockIdpState {
  const { users, groups } = buildFixtures(options);
  return {
    users: new Map(users.map((u) => [u.username, u])),
    groups: new Map(groups.map((g) => [g.id, g])),
    graphFault: { mode: 'none' },
    secrets: new Set([newClientSecret()]),
  };
}

export function userByName(state: MockIdpState, username: string): MockUser {
  const found = state.users.get(username);
  if (found === undefined) throw new UnknownUserError(username);
  return found;
}

export function userByOid(state: MockIdpState, oid: string): MockUser | undefined {
  for (const user of state.users.values()) if (user.oid === oid) return user;
  return undefined;
}

export function patchUser(state: MockIdpState, username: string, patch: UserPatch): MockUser {
  const user = userByName(state, username);
  if (patch.enabled !== undefined) user.enabled = patch.enabled;
  if (patch.deletedInGraph !== undefined) user.deletedInGraph = patch.deletedInGraph;
  if (patch.groups !== undefined) user.groups = [...patch.groups];
  if (patch.groupClaimOverride !== undefined) {
    if (patch.groupClaimOverride === null) delete user.groupClaimOverride;
    else user.groupClaimOverride = [...patch.groupClaimOverride];
  }
  if (patch.amr !== undefined) user.amr = [...patch.amr];
  if (patch.acrs !== undefined) {
    if (patch.acrs === null) delete user.acrs;
    else user.acrs = [...patch.acrs];
  }
  if (patch.ipaddr !== undefined) {
    if (patch.ipaddr === null) delete user.ipaddr;
    else user.ipaddr = patch.ipaddr;
  }
  if (patch.displayName !== undefined) user.displayName = patch.displayName;
  return user;
}

/** Entra "revoke sessions": signInSessionsValidFromDateTime moves to now. */
export function revokeSessions(state: MockIdpState, username: string, at = new Date()): Date {
  const user = userByName(state, username);
  user.signInSessionsValidFrom = at;
  return at;
}

/** Constant-time match against every currently valid RTS client secret. */
export function secretMatches(state: MockIdpState, presented: string): boolean {
  const actual = Buffer.from(presented, 'utf8');
  let ok = false;
  for (const secret of state.secrets) {
    const expected = Buffer.from(secret, 'utf8');
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) ok = true;
  }
  return ok;
}
