// The pinned tenant's OpenID discovery document and its signing keys (F-002 design §3.2.5 step 2,
// §6.3 item 1; [AR-12]). Only `idp.issuer` is ever fetched: the document's `issuer` must equal it
// exactly, and every endpoint it names must be on the issuer's origin, so a tampered document
// can't point RTS at another key set or token endpoint. The document is cached for an hour; a
// failed fetch is retried on the next use.
//
// Keys come from the document's `jwks_uri` through jose's remote key set (cached, refetched on
// an unknown `kid` with a 5 s cooldown).
import { type JWTVerifyGetKey, createRemoteJWKSet } from 'jose';
import { z } from 'zod';

export const DISCOVERY_TTL_MS = 60 * 60 * 1000;
export const DISCOVERY_TIMEOUT_MS = 3000;

const Discovery = z.looseObject({
  issuer: z.string(),
  jwks_uri: z.url(),
  token_endpoint: z.url(),
  authorization_endpoint: z.url(),
  device_authorization_endpoint: z.url().optional(),
});

export interface IdpMetadata {
  issuer: string;
  jwksUri: string;
  tokenEndpoint: string;
  authorizationEndpoint: string;
  deviceAuthorizationEndpoint: string | undefined;
}

export interface IdpMetadataSource {
  get(): Promise<IdpMetadata>;
  /** A jose key resolver over the document's jwks_uri. */
  keys: JWTVerifyGetKey;
}

export class IdpMetadataError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IdpMetadataError';
  }
}

export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

export function createIdpMetadataSource(options: {
  issuer: string;
  fetch?: typeof fetch;
  now?: () => number;
}): IdpMetadataSource {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const origin = new URL(options.issuer).origin;
  let cached: { at: number; metadata: IdpMetadata } | undefined;
  let inflight: Promise<IdpMetadata> | undefined;
  let jwks: { uri: string; resolve: JWTVerifyGetKey } | undefined;

  const load = async (): Promise<IdpMetadata> => {
    const response = await doFetch(discoveryUrl(options.issuer), {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) throw new IdpMetadataError(`discovery answered ${String(response.status)}`);
    const parsed = Discovery.safeParse(await response.json());
    if (!parsed.success) throw new IdpMetadataError('discovery document is malformed');
    const doc = parsed.data;
    if (doc.issuer !== options.issuer) {
      throw new IdpMetadataError('discovery issuer differs from the pinned issuer');
    }
    for (const url of [doc.jwks_uri, doc.token_endpoint, doc.authorization_endpoint]) {
      if (new URL(url).origin !== origin) {
        throw new IdpMetadataError('discovery names an endpoint outside the issuer origin');
      }
    }
    if (
      doc.device_authorization_endpoint !== undefined &&
      new URL(doc.device_authorization_endpoint).origin !== origin
    ) {
      throw new IdpMetadataError('discovery names an endpoint outside the issuer origin');
    }
    return {
      issuer: doc.issuer,
      jwksUri: doc.jwks_uri,
      tokenEndpoint: doc.token_endpoint,
      authorizationEndpoint: doc.authorization_endpoint,
      deviceAuthorizationEndpoint: doc.device_authorization_endpoint,
    };
  };

  const get = async (): Promise<IdpMetadata> => {
    if (cached !== undefined && now() - cached.at < DISCOVERY_TTL_MS) return cached.metadata;
    inflight ??= load()
      .then((metadata) => {
        cached = { at: now(), metadata };
        return metadata;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };

  const keys: JWTVerifyGetKey = async (header, token) => {
    const metadata = await get();
    if (jwks?.uri !== metadata.jwksUri) {
      jwks = {
        uri: metadata.jwksUri,
        resolve: createRemoteJWKSet(new URL(metadata.jwksUri), {
          timeoutDuration: DISCOVERY_TIMEOUT_MS,
          cooldownDuration: 5_000,
          cacheMaxAge: 10 * 60 * 1000,
        }),
      };
    }
    return jwks.resolve(header, token);
  };

  return { get, keys };
}
