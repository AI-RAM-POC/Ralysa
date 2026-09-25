// RTS as an OpenID Connect relying party toward the pinned Entra tenant, for flow B (F-002 design
// §5.2, §3.3; ADR-0010), on openid-client (§2.2). RTS is a confidential client: code + PKCE S256
// + nonce + state toward the IdP, the client secret from OpenBao KV (`client_secret_post`).
//
// - The configuration comes from the pinned issuer's discovery document; openid-client refuses a
//   document whose `issuer` differs. It is cached for an hour and rebuilt when the secret is
//   re-read. Plain `http` is allowed only outside production for the mock IdP; the production
//   guards already refuse an `http` issuer (SEC-F002-12).
// - Code redemption validates the authorization response (state, `iss` when the IdP advertises
//   it) and the ID token (signature RS256, issuer, audience, expiry, nonce); RTS then applies its
//   own pinned claim rules (entra-token-validator.ts `validateIdToken`).
// - `invalid_client` at the token endpoint re-reads the secret once and retries: a failed client
//   authentication doesn't consume the IdP's code (the full rotation watcher is F-002-T13).
// - Every call is bounded (3 s); a network fault or timeout is `unavailable`, any protocol or
//   validation failure is `rejected` (the reason never carries a token or code).
import type { SecretStore } from '@ralysa/secrets';
import * as client from 'openid-client';
import type { ServeConfig } from '../../config/schema.js';

export const OIDC_TIMEOUT_S = 3;
export const OIDC_CONFIG_TTL_MS = 60 * 60 * 1000;
/** The ID token is all RTS needs from the IdP in flow B. */
export const FLOW_B_SCOPE = 'openid profile email';

export type RedeemResult =
  | { kind: 'ok'; idToken: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'rejected'; reason: string };

export interface OidcClient {
  /** The IdP authorization URL for one flow-B attempt. */
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): Promise<string>;
  /** Redeems the IdP code on the callback URL (the full URL RTS was called back on). */
  redeem(
    callbackUrl: URL,
    checks: { state: string; nonce: string; codeVerifier: string },
  ): Promise<RedeemResult>;
}

export function idpCallbackUrl(config: Pick<ServeConfig, 'public_base_url'>): string {
  return `${config.public_base_url.replace(/\/+$/, '')}/oauth2/idp/callback`;
}

const isNetworkFault = (error: unknown): boolean => {
  const name = (error as { name?: unknown }).name;
  return (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    (error instanceof TypeError && !(error instanceof client.ClientError))
  );
};

export function createOidcClient(options: {
  config: Pick<ServeConfig, 'env' | 'idp' | 'public_base_url'>;
  secrets: SecretStore;
  now?: () => number;
}): OidcClient {
  const { config } = options;
  const now = options.now ?? (() => Date.now());
  const insecure = config.env !== 'production' && config.idp.issuer.startsWith('http://');
  let cached: { at: number; configuration: client.Configuration } | undefined;

  const configuration = async (fresh = false): Promise<client.Configuration> => {
    if (!fresh && cached !== undefined && now() - cached.at < OIDC_CONFIG_TTL_MS) {
      return cached.configuration;
    }
    const secret = (await options.secrets.get(config.idp.client_secret_path)).value;
    const built = await client.discovery(
      new URL(config.idp.issuer),
      config.idp.rts_client_id,
      { id_token_signed_response_alg: 'RS256' },
      client.ClientSecretPost(secret),
      {
        timeout: OIDC_TIMEOUT_S,
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- dev/test only: the mock IdP is plain http, and production refuses an http issuer (SEC-F002-12)
        ...(insecure ? { execute: [client.allowInsecureRequests] } : {}),
      },
    );
    built.timeout = OIDC_TIMEOUT_S;
    cached = { at: now(), configuration: built };
    return built;
  };

  return {
    async authorizationUrl(input) {
      const url = client.buildAuthorizationUrl(await configuration(), {
        redirect_uri: idpCallbackUrl(config),
        response_type: 'code',
        scope: FLOW_B_SCOPE,
        state: input.state,
        nonce: input.nonce,
        code_challenge: input.codeChallenge,
        code_challenge_method: 'S256',
      });
      return url.href;
    },

    async redeem(callbackUrl, checks) {
      const grant = async (configurationInUse: client.Configuration) => {
        const tokens = await client.authorizationCodeGrant(configurationInUse, callbackUrl, {
          pkceCodeVerifier: checks.codeVerifier,
          expectedState: checks.state,
          expectedNonce: checks.nonce,
          idTokenExpected: true,
        });
        if (tokens.id_token === undefined) throw new client.ClientError('no ID token');
        return tokens.id_token;
      };
      try {
        let configured: client.Configuration;
        try {
          configured = await configuration();
        } catch (error) {
          return { kind: 'unavailable', reason: isNetworkFault(error) ? 'network' : 'discovery' };
        }
        try {
          return { kind: 'ok', idToken: await grant(configured) };
        } catch (error) {
          if (!(error instanceof client.ResponseBodyError) || error.error !== 'invalid_client') {
            throw error;
          }
          return { kind: 'ok', idToken: await grant(await configuration(true)) };
        }
      } catch (error) {
        if (isNetworkFault(error)) return { kind: 'unavailable', reason: 'network' };
        if (error instanceof client.ResponseBodyError) {
          return error.status >= 500
            ? { kind: 'unavailable', reason: `token_endpoint_${String(error.status)}` }
            : { kind: 'rejected', reason: `token_endpoint_${error.error}`.slice(0, 64) };
        }
        const code = (error as { code?: unknown }).code;
        return {
          kind: 'rejected',
          reason: typeof code === 'string' ? code.slice(0, 64) : 'invalid',
        };
      }
    },
  };
}
