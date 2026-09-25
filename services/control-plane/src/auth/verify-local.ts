// The control plane's own verifier for tokens RTS minted (F-002 design §3.2.2, §3.2.6, §6.1).
// The control plane is a PEP: /v1/me and the internal routes accept only access tokens that pass
// the §3.2.2 checks, and user tokens are checked against revocation read DIRECTLY from the
// database, not through the feed [SEC-F002-18 d]. packages/auth's verifier (T11) implements the
// same rules for other services; this one uses the JWKS rows in-process.
//
// Rejections are reported to the auth.token_rejected aggregator with the org from CONFIG, never
// from the token being rejected (OI-4).
import {
  FORBIDDEN_JOSE_HEADERS,
  TOKEN_LIFETIMES,
  type TokenRejectReason,
  kidPattern,
} from '@ralysa/protocol/auth';
import { type JWTPayload, createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify } from 'jose';
import { type Kysely, sql } from 'kysely';
import type { ServeConfig } from '../config/schema.js';
import { withOrg } from '../db/kysely.js';
import type { Database } from '../db/types.js';
import type { ClientRegistry } from './clients.js';
import type { SigningKeys } from './tokens/signing-keys.js';

export class TokenRejectedError extends Error {
  readonly reason: TokenRejectReason;
  constructor(reason: TokenRejectReason) {
    super(`token rejected: ${reason}`);
    this.name = 'TokenRejectedError';
    this.reason = reason;
  }
}

export interface UserPrincipalClaims extends JWTPayload {
  sub: string;
  sid: string;
  tid: string;
  client_id: string;
  idp_sub: string;
  surface: 'cli' | 'desktop' | 'web' | 'automation';
  token_use: 'access';
}
export interface ServicePrincipalClaims extends JWTPayload {
  sub: string;
  tid: string;
  token_use: 'service';
}

export interface LocalVerifier {
  user(authorization: string | undefined): Promise<UserPrincipalClaims>;
  service(authorization: string | undefined): Promise<ServicePrincipalClaims>;
}

const skew = TOKEN_LIFETIMES.verifierClockSkewSeconds;

export function createLocalVerifier(deps: {
  config: Pick<ServeConfig, 'public_base_url' | 'signing_key' | 'org'>;
  keys: SigningKeys;
  db: Kysely<Database>;
  clients: ClientRegistry;
}): LocalVerifier {
  const issuer = deps.config.public_base_url.replace(/\/+$/, '');
  const kidRule = kidPattern(deps.config.signing_key);
  let jwks: { at: number; set: ReturnType<typeof createLocalJWKSet> } | undefined;
  const jwksSet = async () => {
    if (jwks === undefined || Date.now() - jwks.at > 1_000) {
      jwks = { at: Date.now(), set: createLocalJWKSet(await deps.keys.jwks()) };
    }
    return jwks.set;
  };

  const verify = async (authorization: string | undefined): Promise<JWTPayload> => {
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
      authorization ?? '',
    );
    if (match?.[1] === undefined) throw new TokenRejectedError('malformed');
    const token = match[1];
    let header;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new TokenRejectedError('malformed');
    }
    if (header.alg !== 'ES256') throw new TokenRejectedError('wrong_alg');
    if (header.typ !== 'at+jwt') throw new TokenRejectedError('wrong_typ');
    if (FORBIDDEN_JOSE_HEADERS.some((name) => name in header))
      throw new TokenRejectedError('forbidden_header');
    if (typeof header.kid !== 'string' || !kidRule.test(header.kid))
      throw new TokenRejectedError('unknown_kid');
    try {
      const { payload } = await jwtVerify(token, await jwksSet(), {
        issuer,
        audience: 'control-plane',
        algorithms: ['ES256'],
        typ: 'at+jwt',
        clockTolerance: skew,
        requiredClaims: ['iat', 'exp', 'jti', 'sub', 'tid'],
      });
      if (Array.isArray(payload.aud)) throw new TokenRejectedError('wrong_audience');
      if (typeof payload.iat === 'number' && payload.iat > Date.now() / 1000 + skew) {
        throw new TokenRejectedError('issued_in_future');
      }
      if (payload.tid !== deps.config.org.id) throw new TokenRejectedError('wrong_audience');
      return payload;
    } catch (error) {
      if (error instanceof TokenRejectedError) throw error;
      if (error instanceof errors.JWKSNoMatchingKey) throw new TokenRejectedError('unknown_kid');
      if (error instanceof errors.JWSSignatureVerificationFailed)
        throw new TokenRejectedError('bad_signature');
      if (error instanceof errors.JWTExpired) throw new TokenRejectedError('expired');
      if (error instanceof errors.JWTClaimValidationFailed) {
        if (error.claim === 'iss') throw new TokenRejectedError('unknown_issuer');
        if (error.claim === 'aud') throw new TokenRejectedError('wrong_audience');
        if (error.claim === 'nbf') throw new TokenRejectedError('not_yet_valid');
        if (error.claim === 'typ') throw new TokenRejectedError('wrong_typ');
      }
      throw new TokenRejectedError('malformed');
    }
  };

  return {
    async user(authorization) {
      const payload = await verify(authorization);
      if (payload.token_use !== 'access') throw new TokenRejectedError('wrong_token_use');
      const claims = payload as UserPrincipalClaims;
      const state = await withOrg(
        deps.db,
        deps.config.org.id,
        async (trx) =>
          trx
            .selectFrom('cp.auth_session as s')
            .innerJoin('cp.app_user as u', 'u.id', 's.user_id')
            .select([
              's.status',
              's.user_id',
              sql<boolean>`u.revoked_before is not null and to_timestamp(${claims.iat ?? 0}) < u.revoked_before`.as(
                'userRevoked',
              ),
            ])
            .where('s.id', '=', claims.sid)
            .executeTakeFirst(),
        { readOnly: true },
      );
      if (state === undefined || state.status !== 'active' || state.user_id !== claims.sub) {
        throw new TokenRejectedError('session_revoked');
      }
      if (state.userRevoked) throw new TokenRejectedError('user_revoked');
      return claims;
    },
    async service(authorization) {
      const payload = await verify(authorization);
      if (payload.token_use !== 'service') throw new TokenRejectedError('wrong_token_use');
      const claims = payload as ServicePrincipalClaims;
      if (deps.clients.service(claims.sub) === undefined)
        throw new TokenRejectedError('wrong_token_use');
      return claims;
    },
  };
}
