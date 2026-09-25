// What a successful RTS token response becomes on the client, and the one place that posts to the
// token endpoint for user grants (exchange, code redemption, refresh).
import { type Audience, REFRESH_TOKEN_PATTERN, TokenResponse } from '@ralysa/protocol/auth';
import type { AuthConfig } from '@ralysa/protocol/control-plane';
import { type HttpOptions, NetworkError, request } from '../http.js';
import { rtsEndpoints } from './config.js';
import {
  type AuthError,
  AuthProtocolError,
  TemporarilyUnavailableError,
  rtsError,
} from './errors.js';

export interface TokenSet {
  /** A Ralysa access token (JWT) for `audience`. Keep it in memory only. */
  accessToken: string;
  audience: Audience;
  /** Client clock: when the access token stops being usable. */
  expiresAt: number;
  /** The rotated refresh token (`rly_rt_…`). Store it only in the OS credential store (F-005). */
  refreshToken: string;
}

/** Posts a user grant to the RTS token endpoint and returns the new token set. */
export async function postTokenGrant(
  cfg: Pick<AuthConfig, 'issuer'>,
  form: Record<string, string>,
  audience: Audience,
  context: 'sign_in' | 'refresh',
  options: HttpOptions & { now?: () => number } = {},
): Promise<TokenSet> {
  const now = options.now ?? (() => Date.now());
  const sentAt = now();
  let reply;
  try {
    reply = await request(options, 'POST', rtsEndpoints(cfg).token, { form, what: 'RTS token' });
  } catch (error) {
    if (error instanceof NetworkError) {
      throw new TemporarilyUnavailableError(error.message, 'auth.error.idp_unavailable');
    }
    throw error;
  }
  if (reply.status !== 200) throw rtsError(reply.status, reply.body, context) satisfies AuthError;
  const parsed = TokenResponse.safeParse(reply.body);
  if (
    !parsed.success ||
    parsed.data.refresh_token === undefined ||
    !REFRESH_TOKEN_PATTERN.test(parsed.data.refresh_token) ||
    parsed.data.expires_in <= 0
  ) {
    throw new AuthProtocolError('RTS token response is unusable', 'auth.error.idp_unavailable');
  }
  return {
    accessToken: parsed.data.access_token,
    audience,
    // Measured from when the request left, so a slow answer only shortens the token's life here.
    expiresAt: sentAt + parsed.data.expires_in * 1000,
    refreshToken: parsed.data.refresh_token,
  };
}
