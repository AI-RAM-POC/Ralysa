// Sign-out (F-002 design §5.4; RFC 7009): revoking the refresh token revokes the whole session at
// RTS, and every PEP stops accepting its access tokens within one feed poll. RTS answers 200 for
// an unknown or already revoked token, so a repeated sign-out is harmless.
import { CLI_CLIENT_ID } from '@ralysa/protocol/auth';
import type { AuthConfig } from '@ralysa/protocol/control-plane';
import { NetworkError, request } from '../http.js';
import { type ClientOptions, rtsEndpoints } from './config.js';
import { TemporarilyUnavailableError, rtsError } from './errors.js';

export async function revokeSession(
  cfg: AuthConfig,
  refreshToken: string,
  options: ClientOptions = {},
): Promise<void> {
  let reply;
  try {
    reply = await request(options, 'POST', rtsEndpoints(cfg).revoke, {
      form: { client_id: CLI_CLIENT_ID, token: refreshToken, token_type_hint: 'refresh_token' },
      what: 'RTS revoke',
    });
  } catch (error) {
    if (error instanceof NetworkError) {
      throw new TemporarilyUnavailableError(error.message, 'auth.error.idp_unavailable');
    }
    throw error;
  }
  if (reply.status !== 200) throw rtsError(reply.status, reply.body, 'revoke');
}
