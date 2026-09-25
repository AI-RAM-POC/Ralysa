// Flow B helpers (F-002 design §3.3, §5.2; RFC 7636, RFC 8252): the PKCE pair, the `state`, the
// RTS authorize URL, and reading the loopback callback. The loopback listener itself lives in
// apps/cli (F-005), bound to 127.0.0.1 only [SEC-F002-04 c].
import {
  AUTHORIZATION_CODE_PATTERN,
  AuthorizeQuery,
  CLI_CLIENT_ID,
  RalysaErrorCode,
  SignInReason,
  signInI18nKey,
} from '@ralysa/protocol/auth';
import type { AuthConfig } from '@ralysa/protocol/control-plane';
import { base64url, formBody, newUrl, randomBytes, sha256, utf8 } from '../platform.js';
import { rtsEndpoints } from './config.js';
import { AccessDeniedError, AuthProtocolError } from './errors.js';

/** RFC 7636 §4.1: 32 random bytes → a 43-character verifier; S256 challenge (WebCrypto). */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(await sha256(utf8(verifier)));
  return { verifier, challenge };
}

/** An unguessable `state` (32 random bytes, 43 characters). */
export function createState(): string {
  return base64url(randomBytes(32));
}

/** `GET /oauth2/authorize` for the system browser. Refuses parameters RTS would refuse. */
export function buildAuthorizeUrl(
  cfg: AuthConfig,
  p: { redirectUri: string; challenge: string; state: string },
): { readonly href: string; toString(): string } {
  const query = AuthorizeQuery.parse({
    response_type: 'code',
    client_id: CLI_CLIENT_ID,
    redirect_uri: p.redirectUri,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
  });
  return newUrl(`${rtsEndpoints(cfg).authorize}?${formBody(query)}`);
}

/**
 * Reads the loopback callback's query parameters. Returns the code when `state` matches the one
 * this client sent; throws AccessDeniedError for an RTS or IdP refusal (with the reason's i18n
 * key when RTS names a known one) and AuthProtocolError for anything else, a state mismatch
 * included (a forged or stale callback).
 */
export function readAuthorizationCallback(
  params: Readonly<Record<string, string | undefined>>,
  expectedState: string,
): string {
  if (params.state === undefined || !equalStrings(params.state, expectedState)) {
    throw new AuthProtocolError(
      'callback state does not match',
      'auth.failed.browser_binding_failed',
    );
  }
  if (params.error !== undefined) {
    const reason = SignInReason.safeParse(params.error_description);
    const known = RalysaErrorCode.safeParse(params.error_description);
    throw new AccessDeniedError(
      `sign-in refused (${params.error.slice(0, 64)})`,
      reason.success ? signInI18nKey(reason.data) : 'auth.failed.idp_error',
      known.success ? known.data : undefined,
    );
  }
  const code = params.code;
  if (code === undefined || !AUTHORIZATION_CODE_PATTERN.test(code)) {
    throw new AuthProtocolError('callback has no usable code', 'auth.failed.idp_error');
  }
  return code;
}

/** Length-independent-time string comparison (no early exit on the first difference). */
function equalStrings(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
