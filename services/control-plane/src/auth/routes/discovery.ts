// Discovery routes (F-002 design §3.1, §3.4.1; SEC-F002-33): RFC 8414 metadata, JWKS from the
// signing_key_version table, and /v1/auth/config. All unauthenticated and rate-limited.
import { GRANT_TYPES } from '@ralysa/protocol/auth';
import type { FastifyInstance } from 'fastify';
import type { ServeConfig } from '../../config/schema.js';
import { ROUTES } from '../../http/contracts.js';
import type { SigningKeys } from '../tokens/signing-keys.js';

const base = (url: string): string => url.replace(/\/+$/, '');

/**
 * The IdP device-authorization and token endpoints. Entra's are fixed under the tenant's v2.0
 * authority; T10 may take them from the pinned discovery document instead.
 */
export function idpEndpoints(issuer: string): { device: string; token: string } {
  const authority = base(issuer).replace(/\/v2\.0$/, '');
  return { device: `${authority}/oauth2/v2.0/devicecode`, token: `${authority}/oauth2/v2.0/token` };
}

export function registerDiscovery(
  app: FastifyInstance,
  deps: { config: ServeConfig; keys: SigningKeys },
): void {
  const issuer = base(deps.config.public_base_url);
  app.get(
    ROUTES.metadata.url,
    { schema: { response: { 200: ROUTES.metadata.responses[200].schema } } },
    () => ({
      issuer,
      authorization_endpoint: `${issuer}/oauth2/authorize`,
      token_endpoint: `${issuer}/oauth2/token`,
      revocation_endpoint: `${issuer}/oauth2/revoke`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ['code'] as ['code'],
      grant_types_supported: [...GRANT_TYPES],
      code_challenge_methods_supported: ['S256'] as ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'] as (
        'none' | 'private_key_jwt'
      )[],
      token_endpoint_auth_signing_alg_values_supported: ['ES256'] as ['ES256'],
    }),
  );

  app.get(
    ROUTES.jwks.url,
    { schema: { response: { 200: ROUTES.jwks.responses[200].schema } } },
    async (_req, reply) => {
      for (const [name, value] of Object.entries(ROUTES.jwks.headers)) reply.header(name, value);
      return deps.keys.jwks();
    },
  );

  app.get(
    ROUTES.authConfig.url,
    { schema: { response: { 200: ROUTES.authConfig.responses[200].schema } } },
    () => {
      const endpoints = idpEndpoints(deps.config.idp.issuer);
      return {
        issuer,
        flows: { idp_device: deps.config.access.device_code_enabled, loopback_pkce: true as const },
        idp: {
          kind: 'entra' as const,
          device_authorization_endpoint: endpoints.device,
          token_endpoint: endpoints.token,
          cli_client_id: deps.config.idp.allowed_public_client_ids[0] ?? '',
          scope: deps.config.idp.signin_scope,
        },
        cli_client_id: 'ralysa-cli' as const,
      };
    },
  );
}
