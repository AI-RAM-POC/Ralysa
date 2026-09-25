// Flow A, second leg (F-002 design §3.2.5, §5.1): the IdP access token from the device flow is
// exchanged once at RTS (RFC 8693) for Ralysa tokens. RTS burns the IdP token on the first
// presentation, whatever the outcome, so a failed exchange means starting the device flow again.
// The IdP token is never stored; the caller drops it after this call.
import {
  ACCESS_TOKEN_TYPE_URN,
  type Audience,
  CLI_CLIENT_ID,
  TOKEN_EXCHANGE_GRANT,
} from '@ralysa/protocol/auth';
import { type AuthConfig, SignInFailureReport } from '@ralysa/protocol/control-plane';
import { request } from '../http.js';
import { type ClientOptions, rtsEndpoints } from './config.js';
import { type TokenSet, postTokenGrant } from './token-set.js';

export async function exchangeIdpToken(
  cfg: AuthConfig,
  idpAccessToken: string,
  opts: { audience?: Audience; deviceLabel?: string } & ClientOptions = {},
): Promise<TokenSet> {
  const audience = opts.audience ?? 'control-plane';
  const form: Record<string, string> = {
    grant_type: TOKEN_EXCHANGE_GRANT,
    client_id: CLI_CLIENT_ID,
    subject_token: idpAccessToken,
    subject_token_type: ACCESS_TOKEN_TYPE_URN,
    audience,
  };
  if (opts.deviceLabel !== undefined) form.device_label = opts.deviceLabel.slice(0, 64);
  return postTokenGrant(cfg, form, audience, 'sign_in', opts);
}

/**
 * `POST /v1/auth/sign-in-failures` (AC-4): reports an IdP-side failure of flow A so the attempt is
 * audited. Best effort: it never throws, because the failure the user sees is the IdP's, and a
 * reporting fault must not replace it. Idempotent per `attempt_id` on the server.
 */
export async function reportSignInFailure(
  cfg: AuthConfig,
  report: SignInFailureReport,
  options: ClientOptions = {},
): Promise<void> {
  const parsed = SignInFailureReport.safeParse(report);
  if (!parsed.success) return;
  try {
    await request({ timeoutMs: 5_000, ...options }, 'POST', rtsEndpoints(cfg).signInFailures, {
      json: parsed.data,
      what: 'sign-in failure report',
    });
  } catch {
    // Unreachable or timed out: the server-side rate limits and the IdP's own logs remain.
  }
}
