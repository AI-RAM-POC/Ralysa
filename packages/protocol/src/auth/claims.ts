// Ralysa access tokens (F-002 design §3.2.1, §3.2.2; identity-and-policy §4.2; RFC 9068 profile).
// Groups are deliberately not in the token: services resolve them through PrincipalResolver.
import { z } from 'zod';
import { ACCESS_TOKEN_ALG, ACCESS_TOKEN_TYP } from './version.js';

/** Every access token carries exactly one of these, as a single string (never an array). */
export const Audience = z.enum([
  'control-plane',
  'agent-host',
  'model-gateway',
  'mcp-gateway',
  'workspace-runtime',
]);
export type Audience = z.infer<typeof Audience>;

export const Surface = z.enum(['cli', 'desktop', 'web', 'automation']);
export type Surface = z.infer<typeof Surface>;

/** JOSE header members a verifier refuses outright [SEC-F002-19]. */
export const FORBIDDEN_JOSE_HEADERS = ['jku', 'jwk', 'x5u', 'x5c', 'crit'] as const;

/**
 * The `kid` a Ralysa token may carry: `<signing key>.v<version>`, built from config
 * `vault.signing_key` (for example `ralysa-rts-signing.v3`).
 */
export function kidPattern(signingKey: string): RegExp {
  if (!/^[a-z0-9-]{1,64}$/.test(signingKey)) throw new Error('invalid signing key name');
  return new RegExp(`^${signingKey}\\.v[1-9][0-9]*$`);
}

export function kidFor(signingKey: string, version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('invalid key version');
  return `${signingKey}.v${String(version)}`;
}

/** The JOSE header of every Ralysa access token. Unknown members are kept for the forbidden-header check. */
export const AccessTokenHeader = z.looseObject({
  alg: z.literal(ACCESS_TOKEN_ALG),
  typ: z.literal(ACCESS_TOKEN_TYP),
  kid: z.string().max(80),
});
export type AccessTokenHeader = z.infer<typeof AccessTokenHeader>;

/** Loose: verifiers ignore unknown claims (forward compatibility). */
export const UserAccessTokenClaims = z.looseObject({
  /** Exactly the RTS `public_base_url`. */
  iss: z.url(),
  aud: Audience,
  /** Ralysa user id (UUIDv7). */
  sub: z.uuid(),
  /** RFC 9068. */
  client_id: z.string().max(64),
  /** Ralysa org id; the envelope's `org_id`. */
  tid: z.uuid(),
  /** Auth session (the refresh-token family). */
  sid: z.uuid(),
  /** The IdP's immutable object id (Entra `oid`). */
  idp_sub: z.string().max(128),
  surface: Surface,
  amr: z.array(z.string().max(32)).max(16).optional(),
  auth_time: z.int(),
  /** Organization.region (residency). */
  region: z.string().max(40),
  token_use: z.literal('access'),
  pol_ver: z.string().max(64).optional(),
  ent_ver: z.int().optional(),
  /** RFC 8693 delegation (server host, later features). */
  act: z.looseObject({ sub: z.string().max(200) }).optional(),
  iat: z.int(),
  nbf: z.int(),
  exp: z.int(),
  jti: z.uuid(),
});
export type UserAccessTokenClaims = z.infer<typeof UserAccessTokenClaims>;

export const ServiceAccessTokenClaims = z.looseObject({
  iss: z.url(),
  aud: z.literal('control-plane'),
  sub: z.string().regex(/^svc:[a-z][a-z0-9-]{1,40}$/),
  client_id: z.string().max(64),
  tid: z.uuid(),
  token_use: z.literal('service'),
  iat: z.int(),
  nbf: z.int(),
  exp: z.int(),
  jti: z.uuid(),
});
export type ServiceAccessTokenClaims = z.infer<typeof ServiceAccessTokenClaims>;

/** Why a verifier rejected a token (`auth.token_rejected` `reason_code`, §3.2.2, §6.4). */
export const TokenRejectReason = z.enum([
  'malformed',
  'wrong_alg',
  'wrong_typ',
  'forbidden_header',
  'unknown_kid',
  'bad_signature',
  'unknown_issuer',
  'wrong_audience',
  'expired',
  'not_yet_valid',
  'issued_in_future',
  'wrong_token_use',
  'session_revoked',
  'user_revoked',
  'governance_stale',
]);
export type TokenRejectReason = z.infer<typeof TokenRejectReason>;

/** Lifetimes the design fixes (§3.2.1; D-12, D-18). Configurable ones default to these. */
export const TOKEN_LIFETIMES = {
  accessSeconds: 15 * 60,
  serviceSeconds: 5 * 60,
  refreshIdleSeconds: 12 * 60 * 60,
  refreshAbsoluteSeconds: 7 * 24 * 60 * 60,
  authorizationCodeSeconds: 60,
  clientAssertionMaxSeconds: 60,
  verifierClockSkewSeconds: 30,
} as const;
