// Entra ID token validation for the token-exchange grant (F-002 design §3.2.5 steps 1–3, §6.3
// item 1; SEC-F002-07, -08, -19; AD-5). Everything in the token is untrusted until the signature
// and the pinned claims check out, and even then only `oid` identifies the user (D-21: `sub` is
// pairwise and never used).
//
// 0. Structure: three base64url parts with JSON header and payload. A payload whose `iss` is
//    RTS's own issuer is `untrusted_issuer` before anything else (a Ralysa token is never an IdP
//    token).
// 1. Header: exactly `alg: RS256`, `typ: JWT` and a `kid`; the only other member allowed is
//    Entra's `x5t`. Anything else (`jku`, `jwk`, `x5u`, `x5c`, `crit`, `nonce`, …) is refused.
// 2. Signature: RS256 only, against the pinned tenant's keys (discovery, metadata.ts).
// 3. Claims, in this order: `iss` exactly the configured v2 issuer and `tid` exactly the tenant
//    (`untrusted_issuer`); `exp`/`nbf` with 60 s skew and `iat` at most 10 min old (`expired`);
//    then `ver` "2.0", `aud` = the RTS app registration, `azp` among the allowed public clients,
//    `scp` containing the sign-in scope, a GUID `oid` and a `uti` (`invalid_idp_token`).
//
// The result carries what sign-in needs: `oid`, `tid`, `uti`, times, `amr`/`acrs`, `ipaddr`, the
// display claims and the group claim classified as GUIDs, overage, or absent [SEC-F002-08].
import { type JWTVerifyGetKey, compactVerify, errors } from 'jose';
import { z } from 'zod';
import type { ServeConfig } from '../../config/schema.js';

export const IDP_CLOCK_SKEW_S = 60;
/** AD-5: Entra v2 access tokens carry no auth_time, so freshness is `iat` ≤ 10 min. */
export const IDP_TOKEN_MAX_AGE_S = 600;
const ALLOWED_HEADER = new Set(['alg', 'typ', 'kid', 'x5t']);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `idp_unavailable`: the tenant's keys couldn't be read (discovery or JWKS unreachable, timed out
 * or malformed). That is a dependency fault, not a bad token: the caller answers 503, and since
 * the token isn't burned yet (the replay key comes after this), the client can retry (review of
 * #29, R29-1).
 */
export type IdpTokenFailureReason =
  'invalid_idp_token' | 'untrusted_issuer' | 'expired' | 'idp_unavailable';

export type GroupClaim =
  /** GUID values (lower-cased); `ignored` counts non-GUID values (on-prem names). */
  | { kind: 'list'; guids: string[]; ignored: number }
  /** `_claim_names.groups` present: noted only, `_claim_sources` is never followed. */
  | { kind: 'overage' }
  | { kind: 'absent' };

export interface IdpIdentity {
  issuer: string;
  tenantId: string;
  /** Entra object id: the only identifier Ralysa maps (D-21). */
  oid: string;
  uti: string;
  iat: number;
  exp: number;
  name: string | undefined;
  preferredUsername: string | undefined;
  email: string | undefined;
  amr: string[];
  acrs: string[];
  ipaddr: string | undefined;
  groups: GroupClaim;
}

export type IdpTokenResult =
  | { ok: true; identity: IdpIdentity }
  | {
      ok: false;
      reason: IdpTokenFailureReason;
      /** Which check failed (logs and audit details; never the token). */
      check: string;
      /** The UNVERIFIED preferred_username, for attempted_identifier_hmac only. */
      unverifiedIdentifier: string | undefined;
    };

const Claims = z.looseObject({
  iss: z.string().max(256),
  tid: z.string().max(64),
  ver: z.string().max(8),
  aud: z.string().max(256),
  azp: z.string().max(64).optional(),
  scp: z.string().max(1024).optional(),
  oid: z.string().max(64),
  uti: z.string().min(1).max(64).optional(),
  iat: z.number().int(),
  nbf: z.number().int().optional(),
  exp: z.number().int(),
  name: z.string().max(256).optional(),
  preferred_username: z.string().max(256).optional(),
  email: z.string().max(256).optional(),
  amr: z.array(z.string().max(32)).max(16).optional(),
  acrs: z.array(z.string().max(32)).max(16).optional(),
  ipaddr: z.string().max(64).optional(),
  groups: z.array(z.string().max(256)).max(1000).optional(),
  _claim_names: z.looseObject({}).optional(),
});
type Claims = z.infer<typeof Claims>;

const decodePart = (part: string | undefined): unknown => {
  if (part === undefined || !/^[A-Za-z0-9_-]+$/.test(part)) return undefined;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function classifyGroups(claims: {
  groups?: string[] | undefined;
  _claim_names?: Record<string, unknown> | undefined;
}): GroupClaim {
  if (claims._claim_names !== undefined && 'groups' in claims._claim_names) {
    return { kind: 'overage' };
  }
  if (claims.groups === undefined) return { kind: 'absent' };
  const guids = claims.groups.filter((g) => GUID.test(g)).map((g) => g.toLowerCase());
  return { kind: 'list', guids: [...new Set(guids)], ignored: claims.groups.length - guids.length };
}

export interface EntraTokenValidator {
  /** Flow A: the IdP access token presented at the exchange grant. */
  validateAccessToken(token: string): Promise<IdpTokenResult>;
  /**
   * Flow B: the ID token from RTS's own code redemption at the IdP. The same header, signature,
   * issuer, tenant, freshness, `ver`, `oid` and `uti` rules; `aud` is the RTS app registration,
   * and there is no `azp`/`scp` (the token is RTS's own). openid-client has already checked the
   * nonce, state and PKCE bindings.
   */
  validateIdToken(token: string): Promise<IdpTokenResult>;
}

export function createEntraTokenValidator(deps: {
  config: Pick<ServeConfig, 'idp' | 'public_base_url'>;
  keys: JWTVerifyGetKey;
  now?: () => number;
}): EntraTokenValidator {
  const { idp } = deps.config;
  const rtsIssuer = deps.config.public_base_url.replace(/\/+$/, '');
  const scope = idp.signin_scope.slice(idp.signin_scope.lastIndexOf('/') + 1);
  const nowS = () => Math.floor((deps.now ?? Date.now)() / 1000);

  const validate = async (token: string, kind: 'access' | 'id'): Promise<IdpTokenResult> => {
    const parts = token.split('.');
    const header = decodePart(parts[0]);
    const payload = decodePart(parts[1]);
    const unverifiedIdentifier =
      isObject(payload) && typeof payload.preferred_username === 'string'
        ? payload.preferred_username
        : undefined;
    const fail = (reason: IdpTokenFailureReason, check: string): IdpTokenResult => ({
      ok: false,
      reason,
      check,
      unverifiedIdentifier,
    });
    if (parts.length !== 3 || !isObject(header) || !isObject(payload)) {
      return fail('invalid_idp_token', 'structure');
    }
    if (typeof payload.iss === 'string' && payload.iss.replace(/\/+$/, '') === rtsIssuer) {
      return fail('untrusted_issuer', 'rts_issuer');
    }

    // 1. Header [SEC-F002-07, -19].
    if (header.alg !== 'RS256') return fail('invalid_idp_token', 'alg');
    if (header.typ !== 'JWT') return fail('invalid_idp_token', 'typ');
    if (typeof header.kid !== 'string') return fail('invalid_idp_token', 'kid');
    if (Object.keys(header).some((name) => !ALLOWED_HEADER.has(name))) {
      return fail('invalid_idp_token', 'header_member');
    }

    // 2. Signature, RS256 only, with the pinned tenant's keys. A key-set fault (anything but "no
    //    key has this kid") is the IdP being unavailable, not the token being bad.
    const keyState = { unavailable: false };
    const keys: JWTVerifyGetKey = async (protectedHeader, flattened) => {
      try {
        return await deps.keys(protectedHeader, flattened);
      } catch (error) {
        if (!(error instanceof errors.JWKSNoMatchingKey)) keyState.unavailable = true;
        throw error;
      }
    };
    try {
      await compactVerify(token, keys, { algorithms: ['RS256'] });
    } catch {
      return keyState.unavailable
        ? fail('idp_unavailable', 'keys')
        : fail('invalid_idp_token', 'signature');
    }

    // 3. Claims.
    const parsed = Claims.safeParse(payload);
    if (!parsed.success) return fail('invalid_idp_token', 'claims');
    const claims: Claims = parsed.data;
    if (claims.iss !== idp.issuer) return fail('untrusted_issuer', 'iss');
    if (claims.tid !== idp.tenant_id) return fail('untrusted_issuer', 'tid');
    const now = nowS();
    if (claims.exp <= now - IDP_CLOCK_SKEW_S) return fail('expired', 'exp');
    if (claims.iat < now - IDP_TOKEN_MAX_AGE_S) return fail('expired', 'iat_age');
    if (claims.nbf !== undefined && claims.nbf > now + IDP_CLOCK_SKEW_S) {
      return fail('invalid_idp_token', 'nbf');
    }
    if (claims.iat > now + IDP_CLOCK_SKEW_S) return fail('invalid_idp_token', 'iat_future');
    if (claims.ver !== '2.0') return fail('invalid_idp_token', 'ver');
    if (claims.aud !== idp.rts_client_id) return fail('invalid_idp_token', 'aud');
    if (kind === 'access') {
      if (claims.azp === undefined || !idp.allowed_public_client_ids.includes(claims.azp)) {
        return fail('invalid_idp_token', 'azp');
      }
      if (!(claims.scp ?? '').split(' ').includes(scope)) {
        return fail('invalid_idp_token', 'scp');
      }
    }
    if (!GUID.test(claims.oid)) return fail('invalid_idp_token', 'oid');
    if (claims.uti === undefined) return fail('invalid_idp_token', 'uti');

    return {
      ok: true,
      identity: {
        issuer: claims.iss,
        tenantId: claims.tid,
        oid: claims.oid.toLowerCase(),
        uti: claims.uti,
        iat: claims.iat,
        exp: claims.exp,
        name: claims.name,
        preferredUsername: claims.preferred_username,
        email: claims.email,
        amr: claims.amr ?? [],
        acrs: claims.acrs ?? [],
        ipaddr: claims.ipaddr,
        groups: classifyGroups(claims),
      },
    };
  };
  return {
    validateAccessToken: (token) => validate(token, 'access'),
    validateIdToken: (token) => validate(token, 'id'),
  };
}
