// OAuth contracts at the Ralysa Token Service (F-002 design §3.1, §3.2.5, §3.3; RFC 6749, 7009,
// 7523, 7636, 8252, 8414, 8693). No request accepts a password or any other user-held secret, and
// user clients are public clients: no `client_secret` field exists anywhere here (AC-3).
import { z } from 'zod';
import { Audience } from './claims.js';
import { RalysaErrorCode } from './errors.js';

/** The one public client in Phase 0. */
export const CLI_CLIENT_ID = 'ralysa-cli' as const;

/** Opaque token formats. The prefixes let gitleaks and the log scrubber recognise them (§3.2.1). */
export const REFRESH_TOKEN_PREFIX = 'rly_rt_';
export const AUTHORIZATION_CODE_PREFIX = 'rly_ac_';
export const REFRESH_TOKEN_PATTERN = /^rly_rt_[A-Za-z0-9_-]{43}$/;
export const AUTHORIZATION_CODE_PATTERN = /^rly_ac_[A-Za-z0-9_-]{43}$/;

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE_URN = 'urn:ietf:params:oauth:token-type:access_token';
export const JWT_BEARER_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** Every grant RTS serves. Anything else, `password` included, is `unsupported_grant_type`. */
export const GRANT_TYPES = [
  'authorization_code',
  'refresh_token',
  TOKEN_EXCHANGE_GRANT,
  'client_credentials',
] as const;

/** A TCP port, 1–65535, as decimal without leading zeros. */
const PORT =
  '([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])';

/** Flow B leg 1. RFC 8252 §7.3: IP-literal loopback, any valid port, fixed path. */
export const AuthorizeQuery = z.strictObject({
  response_type: z.literal('code'),
  client_id: z.literal(CLI_CLIENT_ID),
  redirect_uri: z
    .string()
    .regex(new RegExp(`^http://(127\\.0\\.0\\.1|\\[::1\\]):${PORT}/callback$`)),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal('S256'),
  state: z.string().min(16).max(128),
});
export type AuthorizeQuery = z.infer<typeof AuthorizeQuery>;

export const AuthorizationCodeRequest = z.strictObject({
  grant_type: z.literal('authorization_code'),
  client_id: z.literal(CLI_CLIENT_ID),
  code: z.string().regex(AUTHORIZATION_CODE_PATTERN),
  redirect_uri: z.string().max(64),
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});
export type AuthorizationCodeRequest = z.infer<typeof AuthorizationCodeRequest>;

export const RefreshRequest = z.strictObject({
  grant_type: z.literal('refresh_token'),
  client_id: z.literal(CLI_CLIENT_ID),
  refresh_token: z.string().regex(REFRESH_TOKEN_PATTERN),
  /** Ralysa extension (RFC 8693 names it); default `control-plane`. */
  audience: Audience.optional(),
});
export type RefreshRequest = z.infer<typeof RefreshRequest>;

/** Flow A: exchange the IdP access token from the IdP-native device flow (§3.2.5). */
export const TokenExchangeRequest = z.strictObject({
  grant_type: z.literal(TOKEN_EXCHANGE_GRANT),
  client_id: z.literal(CLI_CLIENT_ID),
  subject_token: z.string().min(1).max(8192),
  subject_token_type: z.literal(ACCESS_TOKEN_TYPE_URN),
  audience: Audience.optional(),
  /** Untrusted display text: the server strips control, bidi and zero-width characters. */
  device_label: z.string().max(64).optional(),
});
export type TokenExchangeRequest = z.infer<typeof TokenExchangeRequest>;

/** Services only: an RFC 7523 client assertion signed through the service's own Transit key (§3.2.7). */
export const ClientCredentialsRequest = z.strictObject({
  grant_type: z.literal('client_credentials'),
  client_assertion_type: z.literal(JWT_BEARER_ASSERTION_TYPE),
  client_assertion: z.string().min(1).max(4096),
  client_id: z.string().max(64).optional(),
});
export type ClientCredentialsRequest = z.infer<typeof ClientCredentialsRequest>;

/** `POST /oauth2/token`, dispatched on `grant_type`. */
export const TokenRequest = z.discriminatedUnion('grant_type', [
  AuthorizationCodeRequest,
  RefreshRequest,
  TokenExchangeRequest,
  ClientCredentialsRequest,
]);
export type TokenRequest = z.infer<typeof TokenRequest>;

/** RFC 7009 revocation = sign-out. */
export const RevokeRequest = z.strictObject({
  client_id: z.literal(CLI_CLIENT_ID),
  token: z.string().max(128),
  token_type_hint: z.literal('refresh_token').optional(),
});
export type RevokeRequest = z.infer<typeof RevokeRequest>;

export const TokenResponse = z.strictObject({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.int(),
  refresh_token: z.string().optional(),
  /** Token exchange only. */
  issued_token_type: z.string().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

/** RFC 6749 §5.2 error, plus a Ralysa extension the CLI uses to pick an en/ar message. */
export const OAuthError = z.strictObject({
  error: z.enum([
    'invalid_request',
    'invalid_client',
    'invalid_grant',
    'unauthorized_client',
    'unsupported_grant_type',
    'invalid_scope',
    'access_denied',
    'temporarily_unavailable',
  ]),
  error_description: z.string().optional(),
  ralysa_error: z.strictObject({ code: RalysaErrorCode, i18n_key: z.string() }).optional(),
});
export type OAuthError = z.infer<typeof OAuthError>;

/** RFC 8414 metadata: advertises only what exists (§3.1, §3.10). */
export const AuthorizationServerMetadata = z.looseObject({
  issuer: z.url(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  revocation_endpoint: z.url(),
  jwks_uri: z.url(),
  response_types_supported: z.tuple([z.literal('code')]),
  grant_types_supported: z.array(z.enum(GRANT_TYPES)),
  code_challenge_methods_supported: z.tuple([z.literal('S256')]),
  token_endpoint_auth_methods_supported: z.array(z.enum(['none', 'private_key_jwt'])),
  token_endpoint_auth_signing_alg_values_supported: z.tuple([z.literal('ES256')]),
});
export type AuthorizationServerMetadata = z.infer<typeof AuthorizationServerMetadata>;
