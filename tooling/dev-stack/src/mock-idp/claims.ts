// Entra v2 claim shapes for the mock IdP's tokens (F-002 design §3.2.5, §8.3). Claim semantics
// follow the Entra access-token claims reference: `oid` is the immutable object id, `sub` is
// pairwise per application, `tid` the tenant, `uti` a unique token id, `ver` "2.0". Groups are
// object ids, on-prem-style names for a synced fixture, or overage markers past 200.
import { type KeyObject, createHash, randomBytes, sign as signBytes } from 'node:crypto';
import { type MockUser, OVERAGE_THRESHOLD } from './fixtures.ts';

export const GRAPH_RESOURCE = 'https://graph.microsoft.com';

/** Entra's v1 token issuer, which Graph app tokens carry (not the v2 issuer). */
export const appTokenIssuer = (tenantId: string): string => `https://sts.windows.net/${tenantId}/`;

const b64u = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/** A compact JWS, RS256. Header fields are taken as given (Entra's: alg, typ JWT, kid). */
export function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: KeyObject,
): string {
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  return `${input}.${b64u(signBytes('sha256', Buffer.from(input), key))}`;
}

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
  /** `azpacr`: "0" for a public client (the CLI), "1" for a client secret (RTS). */
  azpacr: '0' | '1';
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
    azpacr: input.azpacr,
    // The RTS app registration requests the `email` optional claim (design §6.7).
    email: user.upn,
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

/** Claims carried over from oidc-provider's ID token (protocol bindings, not identity). */
const ID_TOKEN_PASSTHROUGH = ['nonce', 'sid', 'auth_time', 'at_hash', 'c_hash', 's_hash'] as const;

/**
 * A flow-B ID token's payload, shaped like Entra v2: pairwise `sub` (never the object id), `oid`,
 * `tid`, `uti`, `ver`, the sign-in's `amr`/`acrs`/`ipaddr`, and the group claims.
 */
export function userIdClaims(
  user: MockUser,
  input: {
    issuer: string;
    tenantId: string;
    clientId: string;
    iat: number;
    exp: number;
    graphBaseUrl: string;
    /** oidc-provider's own ID token payload: the protocol bindings are copied from it. */
    original: Record<string, unknown>;
  },
): Record<string, unknown> {
  const bindings: Record<string, unknown> = {};
  for (const name of ID_TOKEN_PASSTHROUGH) {
    if (input.original[name] !== undefined) bindings[name] = input.original[name];
  }
  return {
    aud: input.clientId,
    iss: input.issuer,
    iat: input.iat,
    nbf: input.iat,
    exp: input.exp,
    aio: newTokenId(),
    email: user.upn,
    name: user.displayName,
    oid: user.oid,
    preferred_username: user.upn,
    sub: pairwiseSub(user.oid, input.clientId),
    tid: input.tenantId,
    uti: newTokenId(),
    ver: '2.0',
    ipaddr: user.ipaddr ?? user.lastLoginIp ?? '127.0.0.1',
    amr: [...user.amr],
    ...(user.acrs === undefined ? {} : { acrs: [...user.acrs] }),
    ...groupClaims(user, input.graphBaseUrl),
    ...bindings,
  };
}

/** An app-only (client credentials) token for Graph: Entra's v1 shape and v1 issuer. */
export function appAccessClaims(input: {
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
    iss: appTokenIssuer(input.tenantId),
    iat: input.iat,
    nbf: input.iat,
    exp: input.exp,
    appid: input.clientId,
    appidacr: '1',
    idtyp: 'app',
    oid,
    sub: oid,
    roles: ['User.Read.All', 'GroupMember.Read.All'],
    tid: input.tenantId,
    uti: newTokenId(),
    ver: '1.0',
  };
}
