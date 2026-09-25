// The access-token verifier every Ralysa PEP uses (F-002 design §3.2.2, §3.6, §5.5; AC-7).
//
// Checks, in order, each with its reason code (TokenRejectReason):
//   1. shape: a compact JWS, optionally after `Bearer ` (any case, RFC 7235) → malformed
//   2. header: alg ES256 only (not `none`, not HS256)                       → wrong_alg
//              typ `at+jwt`                                                 → wrong_typ
//              no `jku`, `jwk`, `x5u`, `x5c` or `crit` [SEC-F002-19]        → forbidden_header
//              `kid` = `<signing key>.v<n>`, from config                    → unknown_kid
//   3. signature against RTS's JWKS (cached ≤ 60 s, refetch on unknown kid) → unknown_kid, bad_signature
//   4. claims: `iss` exactly the RTS issuer                                  → unknown_issuer
//              `aud` exactly this PEP's audience, a string, never an array  → wrong_audience
//              `tid` = this deployment's org, when pinned                   → wrong_audience
//              `exp` (30 s skew)                                            → expired
//              `nbf` (30 s skew)                                            → not_yet_valid
//              `iat` not after now + skew [SEC-F002-18 e]                   → issued_in_future
//              `token_use` = access, and the §3.2.2 claim contract          → wrong_token_use, malformed
//   5. governance: the feed confirmed within 60 s (G-1)                      → governance_stale
//              the session isn't revoked                                    → session_revoked
//              `iat` isn't before the user's `revoked_before`               → user_revoked
//
// The verifier never trusts the token for anything it reports: `onReject` gets the reason, and the
// caller supplies client IP and trace id. A PEP aggregates rejections into `auth.token_rejected`
// under its CONFIGURED org, never the rejected token's `tid` (OI-4, SEC-F002-16).
//
// Not a rejection: when the JWKS can't be fetched at all, `verify` throws VerifierUnavailableError,
// so the PEP answers 503 instead of recording a bogus `auth.token_rejected`. Either way it fails
// closed.
import {
  ACCESS_TOKEN_ALG,
  ACCESS_TOKEN_TYP,
  type Audience,
  FORBIDDEN_JOSE_HEADERS,
  type Surface,
  TOKEN_LIFETIMES,
  type TokenRejectReason,
  UserAccessTokenClaims,
  kidPattern,
} from '@ralysa/protocol/auth';
import { type JWTPayload, decodeProtectedHeader, errors, jwtVerify } from 'jose';
import type { Fetch } from '../platform.js';
import { type JwksKeySet, createJwksCache } from './jwks.js';
import type { RevocationSource } from './revocation-feed.js';

export interface VerifiedPrincipal {
  userId: string;
  orgId: string;
  sessionId: string;
  idpSubject: string;
  audience: Audience;
  surface: Surface;
  expiresAt: Date;
  /** The token's `jti` (for audit correlation; never the token itself). */
  tokenId: string;
}

export type VerifyResult =
  { ok: true; principal: VerifiedPrincipal } | { ok: false; reason: TokenRejectReason };

export interface RejectInfo {
  reason: TokenRejectReason;
  clientIp?: string;
  traceId?: string;
}

export interface AccessTokenVerifierOptions {
  /** Exact match (RTS `public_base_url`, no trailing slash). */
  issuer: string;
  /** Exactly one. */
  audience: Audience;
  /** RTS `/.well-known/jwks.json`. */
  jwksUrl: string;
  /** Config `vault.signing_key`; the `kid` must be `<kidPrefix>.v<n>` [SEC-F002-19]. */
  kidPrefix: string;
  /** The feed (services) or the database (control plane). */
  revocation: RevocationSource;
  /** When set, a token of another org is refused (single-org deployments, ADR-0003). */
  orgId?: string;
  /** Default 30. */
  clockSkewSeconds?: number;
  onReject?: (r: RejectInfo) => void;
  /** For tests and non-global fetch; also the JWKS fetch. */
  fetch?: Fetch;
  /** Instead of a remote JWKS (tests, or a PEP that already holds the key set). */
  keySet?: JwksKeySet;
  now?: () => number;
}

export interface AccessTokenVerifier {
  verify(bearer: string, context?: { clientIp?: string; traceId?: string }): Promise<VerifyResult>;
}

export class VerifierUnavailableError extends Error {
  constructor() {
    super('the verification keys could not be fetched');
    this.name = 'VerifierUnavailableError';
  }
}

const COMPACT_JWS = /^[A-Za-z0-9_-]{2,8192}\.[A-Za-z0-9_-]{2,16384}\.[A-Za-z0-9_-]{2,1024}$/;

class Rejected extends Error {
  constructor(readonly reason: TokenRejectReason) {
    super(reason);
  }
}

export function createAccessTokenVerifier(opts: AccessTokenVerifierOptions): AccessTokenVerifier {
  const issuer = opts.issuer.replace(/\/+$/, '');
  const kidRule = kidPattern(opts.kidPrefix);
  const skew = opts.clockSkewSeconds ?? TOKEN_LIFETIMES.verifierClockSkewSeconds;
  const now = opts.now ?? (() => Date.now());
  const keySet =
    opts.keySet ??
    createJwksCache({
      url: opts.jwksUrl,
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
    });

  const check = async (bearer: string): Promise<VerifiedPrincipal> => {
    const token = /^bearer /i.test(bearer) ? bearer.slice(7) : bearer;
    if (!COMPACT_JWS.test(token)) throw new Rejected('malformed');
    let header;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new Rejected('malformed');
    }
    if (header.alg !== ACCESS_TOKEN_ALG) throw new Rejected('wrong_alg');
    if (header.typ !== ACCESS_TOKEN_TYP) throw new Rejected('wrong_typ');
    if (FORBIDDEN_JOSE_HEADERS.some((name) => Object.hasOwn(header, name))) {
      throw new Rejected('forbidden_header');
    }
    if (typeof header.kid !== 'string' || header.kid.length > 80 || !kidRule.test(header.kid)) {
      throw new Rejected('unknown_kid');
    }

    const nowMs = now();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keySet, {
        algorithms: [ACCESS_TOKEN_ALG],
        typ: ACCESS_TOKEN_TYP,
        issuer,
        audience: opts.audience,
        clockTolerance: skew,
        currentDate: new Date(nowMs),
        requiredClaims: ['iat', 'nbf', 'exp', 'sub', 'jti'],
      }));
    } catch (error) {
      throw mapJoseError(error);
    }
    // jose accepts an array containing the audience; RTS tokens carry exactly one string.
    if (Array.isArray(payload.aud)) throw new Rejected('wrong_audience');
    if (typeof payload.iat === 'number' && payload.iat > nowMs / 1000 + skew) {
      throw new Rejected('issued_in_future');
    }
    if (payload.token_use !== 'access') throw new Rejected('wrong_token_use');
    const claims = UserAccessTokenClaims.safeParse(payload);
    if (!claims.success) throw new Rejected('malformed');
    if (opts.orgId !== undefined && claims.data.tid !== opts.orgId) {
      throw new Rejected('wrong_audience');
    }

    const verdict = await opts.revocation.check({
      sid: claims.data.sid,
      sub: claims.data.sub,
      iat: claims.data.iat,
    });
    if (verdict !== 'ok') throw new Rejected(verdict);

    return {
      userId: claims.data.sub,
      orgId: claims.data.tid,
      sessionId: claims.data.sid,
      idpSubject: claims.data.idp_sub,
      audience: claims.data.aud,
      surface: claims.data.surface,
      expiresAt: new Date(claims.data.exp * 1000),
      tokenId: claims.data.jti,
    };
  };

  return {
    async verify(bearer, context = {}) {
      try {
        return { ok: true, principal: await check(bearer) };
      } catch (error) {
        if (!(error instanceof Rejected)) throw error;
        try {
          opts.onReject?.({ reason: error.reason, ...context });
        } catch {
          // Recording a rejection never changes the answer.
        }
        return { ok: false, reason: error.reason };
      }
    },
  };
}

function mapJoseError(error: unknown): Error {
  if (error instanceof errors.JWKSNoMatchingKey) return new Rejected('unknown_kid');
  if (error instanceof errors.JWKSMultipleMatchingKeys) return new Rejected('unknown_kid');
  if (error instanceof errors.JWSSignatureVerificationFailed) return new Rejected('bad_signature');
  if (error instanceof errors.JWTExpired) return new Rejected('expired');
  if (error instanceof errors.JWTClaimValidationFailed) {
    // A claim that is missing or not the right type is a malformed token, not a wrong value.
    if (error.reason !== 'check_failed') return new Rejected('malformed');
    switch (error.claim) {
      case 'iss':
        return new Rejected('unknown_issuer');
      case 'aud':
        return new Rejected('wrong_audience');
      case 'nbf':
        return new Rejected('not_yet_valid');
      case 'typ':
        return new Rejected('wrong_typ');
      default:
        return new Rejected('malformed');
    }
  }
  if (error instanceof errors.JOSEAlgNotAllowed) return new Rejected('wrong_alg');
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) {
    return new VerifierUnavailableError();
  }
  if (error instanceof errors.JOSEError && error.code === 'ERR_JOSE_GENERIC') {
    // jose's remote set reports a failed JWKS fetch or a non-200 as a plain JOSEError.
    return new VerifierUnavailableError();
  }
  if (error instanceof errors.JOSEError) return new Rejected('malformed');
  // A fetch that threw (DNS, connection refused) surfaces as a non-JOSE error.
  return new VerifierUnavailableError();
}
