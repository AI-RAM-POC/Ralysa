// Typed client errors (F-002 design §3.6, §3.9). Each carries an i18n key the CLI (F-005) turns
// into an en/ar message. A key RTS sends in `ralysa_error.i18n_key` is used only if it is one of
// the protocol's known keys: the response is external input, so anything else falls back to the
// error's default key.
import { AUTH_I18N_KEYS, OAuthError } from '@ralysa/protocol/auth';
import { z } from 'zod';

const KNOWN_KEYS = new Set(AUTH_I18N_KEYS);

export type AuthErrorCode =
  | 'access_denied'
  | 'device_code_expired'
  | 'device_code_blocked'
  | 'session_revoked'
  | 'temporarily_unavailable'
  | 'protocol_error';

export abstract class AuthError extends Error {
  abstract readonly code: AuthErrorCode;
  /** `auth.<denied|failed|error>.<reason>`; always one of AUTH_I18N_KEYS. */
  readonly i18nKey: string;
  /** `ralysa_error.code` from RTS, or the IdP-neutral failure the client reported. */
  readonly reason: string | undefined;

  constructor(message: string, i18nKey: string, reason?: string) {
    super(message);
    this.name = new.target.name;
    this.i18nKey = KNOWN_KEYS.has(i18nKey) ? i18nKey : 'auth.error.idp_unavailable';
    this.reason = reason;
  }
}

/** The IdP or RTS refused the sign-in (declined, not in the access group, disabled, …). */
export class AccessDeniedError extends AuthError {
  readonly code = 'access_denied';
}

/** The device code expired before the user finished at the IdP. Start again. */
export class DeviceCodeExpiredError extends AuthError {
  readonly code = 'device_code_expired';
}

/**
 * The IdP blocked the device flow (for example a Conditional Access policy against device code).
 * The CLI suggests `/login --browser`.
 */
export class DeviceCodeBlockedError extends AuthError {
  readonly code = 'device_code_blocked';
}

/** The session is gone (signed out, reuse detected, user disabled): sign in again. */
export class SessionRevokedError extends AuthError {
  readonly code = 'session_revoked';
}

/**
 * RTS or the IdP could not serve the request. When the server ANSWERED (`temporarily_unavailable`,
 * 429, 5xx) nothing was consumed and a retry is safe. When no answer arrived at all, the error is
 * the ResponseLostError subclass, whose `lostResponse` is true: see there.
 */
export class TemporarilyUnavailableError extends AuthError {
  readonly code = 'temporarily_unavailable';
  /** True when the request may have been processed without its answer reaching us. */
  readonly lostResponse: boolean = false;
}

/**
 * A token request got no answer (connection dropped, timeout). RTS may have processed it. For a
 * refresh that means the presented refresh token may already be rotated: a retry with it is
 * reuse, RTS revokes the session, and the retry fails with SessionRevokedError (sign in again).
 * For a sign-in grant the IdP token or code may already be burned. There is no grace window (D-27).
 */
export class ResponseLostError extends TemporarilyUnavailableError {
  override readonly lostResponse: boolean = true;
}

/** An answer this client can't use (bad shape, unexpected status, invalid request). */
export class AuthProtocolError extends AuthError {
  readonly code = 'protocol_error';
}

/** The IdP's own error body (RFC 6749 §5.2 / RFC 8628 §3.5); vendor members are kept. */
export const IdpOAuthError = z.looseObject({
  error: z.string().max(128),
  error_description: z.string().max(2048).optional(),
});
export type IdpOAuthError = z.infer<typeof IdpOAuthError>;

/**
 * Turns a non-2xx RTS token or revoke answer into a typed error. For a refresh, `invalid_grant`
 * means the session is dead; for a sign-in grant (exchange, code redemption) it means the IdP
 * token or code was refused, which is a failed sign-in. `access_denied` and `unauthorized_client`
 * are policy decisions; `temporarily_unavailable`, 429 and 5xx are retryable faults.
 */
export function rtsError(
  status: number,
  body: unknown,
  context: 'sign_in' | 'refresh' | 'revoke',
): AuthError {
  const fallbackKey = context === 'refresh' ? 'auth.denied.revoked' : 'auth.failed.idp_error';
  const parsed = OAuthError.safeParse(body);
  if (!parsed.success) {
    return status >= 500 || status === 429
      ? new TemporarilyUnavailableError(
          `RTS answered ${String(status)}`,
          'auth.error.idp_unavailable',
        )
      : new AuthProtocolError(`RTS answered ${String(status)}`, fallbackKey);
  }
  const { error, ralysa_error: detail } = parsed.data;
  const message = `RTS: ${error}${detail === undefined ? '' : ` (${detail.code})`}`;
  switch (error) {
    case 'invalid_grant':
      return context === 'refresh'
        ? new SessionRevokedError(message, detail?.i18n_key ?? fallbackKey, detail?.code)
        : new AccessDeniedError(message, detail?.i18n_key ?? fallbackKey, detail?.code);
    case 'access_denied':
    case 'unauthorized_client':
      return new AccessDeniedError(message, detail?.i18n_key ?? fallbackKey, detail?.code);
    case 'temporarily_unavailable':
      return new TemporarilyUnavailableError(
        message,
        detail?.i18n_key ?? 'auth.error.idp_unavailable',
        detail?.code,
      );
    default:
      return new AuthProtocolError(message, detail?.i18n_key ?? fallbackKey, detail?.code);
  }
}
