// Entra v2 claim shapes for the mock IdP's tokens (F-002 design §3.2.5, §8.3). Claim semantics
// follow the Entra access-token claims reference: `oid` is the immutable object id, `sub` is
// pairwise per application, `tid` the tenant, `uti` a unique token id, `ver` "2.0". Groups are
// object ids, on-prem-style names for a synced fixture, or overage markers past 200.
import { createHash, randomBytes } from 'node:crypto';
import { type MockUser, OVERAGE_THRESHOLD } from './fixtures.ts';

export const GRAPH_RESOURCE = 'https://graph.microsoft.com';

/** Entra's pairwise `sub`: stable per (user, application), never the object id. */
export const pairwiseSub = (oid: string, applicationId: string): string =>
  createHash('sha256').update(`${oid}|${applicationId}`).digest('base64url');

/** `uti`, `aio`: 16 random bytes, base64url (22 characters, like Entra's). */
export const newTokenId = (): string => randomBytes(16).toString('base64url');

export function groupClaims(user: MockUser, graphBaseUrl: string): Record<string, unknown> {
  if (user.groupClaimOverride !== undefined) return { groups: [...user.groupClaimOverride] };
  if (user.groups.length > OVERAGE_THRESHOLD) {
    return {
      _claim_names: { groups: 'src1' },
      _claim_sources: {
        src1: { endpoint: `${graphBaseUrl}/v1.0/users/${user.oid}/getMemberObjects` },
      },
    };
  }
  return { groups: [...user.groups] };
}

export interface AccessClaimInput {
  issuer: string;
  tenantId: string;
  /** The resource application's client id (Entra v2 `aud`). */
  audience: string;
  /** The requesting client's id. */
  azp: string;
  scp: string;
  iat: number;
  exp: number;
  graphBaseUrl: string;
}

/** A delegated (user) access token's payload, shaped like Entra v2. */
export function userAccessClaims(user: MockUser, input: AccessClaimInput): Record<string, unknown> {
  return {
    aud: input.audience,
    iss: input.issuer,
    iat: input.iat,
    nbf: input.iat,
    exp: input.exp,
    aio: newTokenId(),
    azp: input.azp,
    azpacr: '0',
    name: user.displayName,
    oid: user.oid,
    preferred_username: user.upn,
    scp: input.scp,
    sub: pairwiseSub(user.oid, input.audience),
    tid: input.tenantId,
    uti: newTokenId(),
    ver: '2.0',
    ipaddr: user.ipaddr ?? user.lastLoginIp ?? '127.0.0.1',
    amr: [...user.amr],
    ...(user.acrs === undefined ? {} : { acrs: [...user.acrs] }),
    ...groupClaims(user, input.graphBaseUrl),
  };
}

/** An app-only (client credentials) token for Graph. */
export function appAccessClaims(input: {
  issuer: string;
  tenantId: string;
  audience: string;
  clientId: string;
  iat: number;
  exp: number;
}): Record<string, unknown> {
  const servicePrincipal = createHash('sha256').update(`sp|${input.clientId}`).digest('hex');
  const oid = [
    servicePrincipal.slice(0, 8),
    servicePrincipal.slice(8, 12),
    `4${servicePrincipal.slice(13, 16)}`,
    `8${servicePrincipal.slice(17, 20)}`,
    servicePrincipal.slice(20, 32),
  ].join('-');
  return {
    aud: input.audience,
    iss: input.issuer,
    iat: input.iat,
    nbf: input.iat,
    exp: input.exp,
    appid: input.clientId,
    azp: input.clientId,
    idtyp: 'app',
    oid,
    sub: oid,
    roles: ['User.Read.All', 'GroupMember.Read.All'],
    tid: input.tenantId,
    uti: newTokenId(),
    ver: '1.0',
  };
}
