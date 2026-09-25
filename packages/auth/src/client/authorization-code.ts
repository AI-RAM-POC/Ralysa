// Flow B, last leg (F-002 design §3.3, §5.2): redeem the `rly_ac_` code from the loopback callback
// with the PKCE verifier. RTS writes `auth.sign_in` at redemption and checks that the redeeming
// host is the one the browser came back to; a code is single use.
import { type Audience, AuthorizationCodeRequest, CLI_CLIENT_ID } from '@ralysa/protocol/auth';
import type { AuthConfig } from '@ralysa/protocol/control-plane';
import type { ClientOptions } from './config.js';
import { AuthProtocolError } from './errors.js';
import { type TokenSet, postTokenGrant } from './token-set.js';

export async function redeemAuthorizationCode(
  cfg: AuthConfig,
  p: { code: string; redirectUri: string; verifier: string },
  options: ClientOptions = {},
): Promise<TokenSet> {
  const form = AuthorizationCodeRequest.safeParse({
    grant_type: 'authorization_code',
    client_id: CLI_CLIENT_ID,
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
  });
  if (!form.success) {
    throw new AuthProtocolError('authorization code request is invalid', 'auth.failed.idp_error');
  }
  const audience: Audience = 'control-plane';
  return postTokenGrant(cfg, form.data, audience, 'sign_in', options);
}
