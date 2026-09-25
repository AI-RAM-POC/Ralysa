// `GET /v1/auth/config` (F-002 design §3.4.1): which sign-in flows the tenant allows and where the
// IdP's device and token endpoints are. The answer is validated, and its `issuer` must be the
// issuer the client asked, so a config can't send later calls to another server.
import { AuthConfig } from '@ralysa/protocol/control-plane';
import { type HttpOptions, NetworkError, joinUrl, request } from '../http.js';
import { AuthProtocolError, TemporarilyUnavailableError } from './errors.js';

export type ClientOptions = HttpOptions;

export async function fetchAuthConfig(
  issuer: string,
  options: ClientOptions = {},
): Promise<AuthConfig> {
  const base = issuer.replace(/\/+$/, '');
  let reply;
  try {
    reply = await request(options, 'GET', joinUrl(base, '/v1/auth/config'), {
      what: 'auth config',
    });
  } catch (error) {
    if (error instanceof NetworkError) {
      throw new TemporarilyUnavailableError(error.message, 'auth.error.idp_unavailable');
    }
    throw error;
  }
  if (reply.status >= 500 || reply.status === 429) {
    throw new TemporarilyUnavailableError(
      `auth config answered ${String(reply.status)}`,
      'auth.error.idp_unavailable',
    );
  }
  const parsed = reply.status === 200 ? AuthConfig.safeParse(reply.body) : undefined;
  if (parsed?.success !== true) {
    throw new AuthProtocolError(
      `auth config answered ${String(reply.status)} with an unusable body`,
      'auth.failed.idp_error',
    );
  }
  if (parsed.data.issuer.replace(/\/+$/, '') !== base) {
    throw new AuthProtocolError('auth config names another issuer', 'auth.failed.untrusted_issuer');
  }
  return parsed.data;
}

/** RTS endpoints under the configured issuer (§3.1; fixed paths). */
export const rtsEndpoints = (cfg: Pick<AuthConfig, 'issuer'>) => {
  const base = cfg.issuer.replace(/\/+$/, '');
  return {
    token: joinUrl(base, '/oauth2/token'),
    revoke: joinUrl(base, '/oauth2/revoke'),
    authorize: joinUrl(base, '/oauth2/authorize'),
    signInFailures: joinUrl(base, '/v1/auth/sign-in-failures'),
  };
};
