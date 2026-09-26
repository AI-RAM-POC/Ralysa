// RTS as an OpenID Connect relying party toward the pinned Entra tenant, for flow B (F-002 design
// §5.2, §3.3; ADR-0010), on openid-client (§2.2). RTS is a confidential client: code + PKCE S256
// + nonce + state toward the IdP, the client secret from OpenBao KV (`client_secret_post`).
//
// - The configuration comes from the pinned issuer's discovery document; openid-client refuses a
//   document whose `issuer` differs. The document is cached for an hour; the client configuration
//   is rebuilt from it whenever the secret watcher (src/secrets/runtime.ts, F-002-T13) holds a new
//   version. Plain `http` is allowed only outside production for the mock IdP; the production
//   guards already refuse an `http` issuer (SEC-F002-12).
// - Code redemption validates the authorization response (state, `iss` when the IdP advertises
//   it) and the ID token (signature RS256, issuer, audience, expiry, nonce); RTS then applies its
//   own pinned claim rules (entra-token-validator.ts `validateIdToken`).
// - `invalid_client` at the token endpoint asks the watcher to re-read the secret at once and
//   retries once, only with a newer version: a failed client authentication doesn't consume the
//   IdP's code, so the retry is safe (T10-32, F-002-T13).
// - Every call is bounded (3 s), the secret watcher's KV reads included (review of #35: the
//   OpenBao client's own timeout is 5 s); a network fault or timeout is `unavailable`, any protocol or
//   validation failure is `rejected` (the reason never carries a token or code).
import type { SecretStore, SecretValue } from '@ralysa/secrets';
import * as client from 'openid-client';
import type { ServeConfig } from '../../config/schema.js';
import { type IdpClientSecret, createIdpClientSecret } from '../../secrets/runtime.js';

export const OIDC_TIMEOUT_S = 3;

/** Settles with `promise`, or rejects with a TimeoutError after OIDC_TIMEOUT_S. */
function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DOMException('the secret read timed out', 'TimeoutError'));
    }, OIDC_TIMEOUT_S * 1000);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
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
  /**
   * The process's secret watcher (serve shares one with the Graph directory). Without it, one is
   * built over `secrets` that reads on first use and on `invalid_client` only (tests).
   */
  clientSecret?: IdpClientSecret;
  secrets?: SecretStore;
  now?: () => number;
}): OidcClient {
  const { config } = options;
  const now = options.now ?? (() => Date.now());
  const insecure = config.env !== 'production' && config.idp.issuer.startsWith('http://');
  const clientSecret =
    options.clientSecret ??
    (() => {
      if (options.secrets === undefined) throw new Error('oidc client: no client secret source');
      return createIdpClientSecret({
        secrets: options.secrets,
        path: config.idp.client_secret_path,
      });
    })();
  /** The discovery document, fetched at most once an hour. */
  let discovered: { at: number; server: client.ServerMetadata } | undefined;
  /** The client configuration for one secret version, built on the cached document. */
  let built:
    | { version: number; server: client.ServerMetadata; configuration: client.Configuration }
    | undefined;

  const serverMetadata = async (): Promise<client.ServerMetadata> => {
    if (discovered !== undefined && now() - discovered.at < OIDC_CONFIG_TTL_MS) {
      return discovered.server;
    }
    // Discovery authenticates nothing: the client authentication is attached per secret version.
    const found = await client.discovery(
      new URL(config.idp.issuer),
      config.idp.rts_client_id,
      { id_token_signed_response_alg: 'RS256' },
      client.None(),
      {
        timeout: OIDC_TIMEOUT_S,
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- dev/test only: the mock IdP is plain http, and production refuses an http issuer (SEC-F002-12)
        ...(insecure ? { execute: [client.allowInsecureRequests] } : {}),
      },
    );
    discovered = { at: now(), server: found.serverMetadata() };
    return discovered.server;
  };

  const configuration = async (secret: SecretValue): Promise<client.Configuration> => {
    const server = await serverMetadata();
    if (built !== undefined && built.version === secret.version && built.server === server) {
      return built.configuration;
    }
    const configured = new client.Configuration(
      server,
      config.idp.rts_client_id,
      { id_token_signed_response_alg: 'RS256' },
      client.ClientSecretPost(secret.value),
    );
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- dev/test only, as above
    if (insecure) client.allowInsecureRequests(configured);
    configured.timeout = OIDC_TIMEOUT_S;
    built = { version: secret.version, server, configuration: configured };
    return configured;
  };

  return {
    async authorizationUrl(input) {
      const url = client.buildAuthorizationUrl(
        await configuration(await bounded(clientSecret.current())),
        {
          redirect_uri: idpCallbackUrl(config),
          response_type: 'code',
          scope: FLOW_B_SCOPE,
          state: input.state,
          nonce: input.nonce,
          code_challenge: input.codeChallenge,
          code_challenge_method: 'S256',
        },
      );
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
        let used: SecretValue;
        let configured: client.Configuration;
        try {
          used = await bounded(clientSecret.current());
        } catch {
          return { kind: 'unavailable', reason: 'client_secret' };
        }
        try {
          configured = await configuration(used);
        } catch (error) {
          return { kind: 'unavailable', reason: isNetworkFault(error) ? 'network' : 'discovery' };
        }
        try {
          return { kind: 'ok', idToken: await grant(configured) };
        } catch (error) {
          if (!(error instanceof client.ResponseBodyError) || error.error !== 'invalid_client') {
            throw error;
          }
          // Rotated: re-read at once and retry once, only with a newer version (F-002-T13).
          let next: SecretValue | undefined;
          try {
            next = await bounded(clientSecret.refreshAfterInvalidClient(used.version));
          } catch {
            return { kind: 'unavailable', reason: 'client_secret' };
          }
          if (next === undefined) throw error;
          return { kind: 'ok', idToken: await grant(await configuration(next)) };
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
