// @ralysa/auth: isomorphic library (loads in browsers and Node; no DOM, no Node built-ins).
// The token verifier every Ralysa service uses and the client sign-in flows the CLI wraps
// (F-002 design §3.6). There is deliberately no file-backed TokenStore here.
export const PACKAGE_NAME = '@ralysa/auth';

export function packageName(): string {
  return PACKAGE_NAME;
}

// Services (PEPs)
export {
  type AccessTokenVerifier,
  type AccessTokenVerifierOptions,
  type CommonVerifierOptions,
  type KeyResolver,
  type RejectInfo,
  type ServiceTokenVerifier,
  type ServiceTokenVerifierOptions,
  type ServiceVerifyResult,
  type VerifiedPrincipal,
  type VerifiedService,
  type VerifyContext,
  type VerifyResult,
  VerifierUnavailableError,
  createAccessTokenVerifier,
  createServiceTokenVerifier,
} from './verify/access-token-verifier.js';
export {
  JWKS_CACHE_MAX_AGE_MS,
  JWKS_COOLDOWN_MS,
  type JwksKeySet,
  createJwksCache,
} from './verify/jwks.js';
export {
  type KillSwitchState,
  type PollOutcome,
  type RevocationFeed,
  type RevocationFeedOptions,
  type RevocationSource,
  type RevocationVerdict,
  createRevocationFeed,
} from './verify/revocation-feed.js';
export {
  type RejectionReporter,
  type RejectionReporterOptions,
  createRejectionReporter,
} from './verify/rejection-reporter.js';
export {
  type PrincipalResolver,
  type PrincipalResolverOptions,
  type SessionPrincipal,
  PrincipalNotFoundError,
  PrincipalSessionRefusedError,
  PrincipalUnavailableError,
  createPrincipalResolver,
} from './verify/principal-resolver.js';
export {
  type ManagedServiceTokenSource,
  type ServiceTokenSource,
  type ServiceTokenSourceOptions,
  ServiceTokenUnavailableError,
  createServiceTokenSource,
} from './service/service-token-source.js';
export {
  ASSERTION_LIFETIME_S,
  type AssertionSigner,
  type TransitSigning,
  createClientAssertion,
  createTransitAssertionSigner,
} from './service/client-assertion.js';

// Clients (CLI in F-005; Desktop and Web later)
export { type ClientOptions, fetchAuthConfig } from './client/config.js';
export {
  DEVICE_CODE_GRANT,
  type IdpDeviceOptions,
  type IdpDeviceSignIn,
  type IdpErrorClassifier,
  startIdpDeviceSignIn,
} from './client/idp-device.js';
export { exchangeIdpToken, reportSignInFailure } from './client/exchange.js';
export {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  readAuthorizationCallback,
} from './client/pkce.js';
export { redeemAuthorizationCode } from './client/authorization-code.js';
export {
  type TokenManager,
  type TokenManagerOptions,
  type TokenStore,
  createTokenManager,
} from './client/token-manager.js';
export { revokeSession } from './client/revoke.js';
export type { TokenSet } from './client/token-set.js';
export {
  AccessDeniedError,
  AuthError,
  type AuthErrorCode,
  AuthProtocolError,
  DeviceCodeBlockedError,
  DeviceCodeExpiredError,
  ResponseLostError,
  SessionRevokedError,
  TemporarilyUnavailableError,
} from './client/errors.js';
export type { AbortSignalLike, Fetch, FetchInit, FetchResponse } from './platform.js';
