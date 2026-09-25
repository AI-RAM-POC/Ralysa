// Route contracts: method, path and response schemas for every route of the serve process
// (F-002 design §3.1, §3.10). The app registers its routes with these schemas and the OpenAPI
// document is generated from the same objects, so what is validated is what is published. Later
// tasks append their routes here.
import { AuthorizationServerMetadata } from '@ralysa/protocol/auth';
import { Problem } from '@ralysa/protocol/common';
import { AuthConfig } from '@ralysa/protocol/control-plane';
import { z } from 'zod';

export const Jwks = z.strictObject({
  keys: z.array(
    z.strictObject({
      kty: z.literal('EC'),
      crv: z.literal('P-256'),
      x: z.string(),
      y: z.string(),
      kid: z.string(),
      alg: z.literal('ES256'),
      use: z.literal('sig'),
    }),
  ),
});

export const Health = z.strictObject({ status: z.literal('ok') });
export const Readiness = z.strictObject({
  status: z.enum(['ready', 'unready']),
  checks: z.strictObject({
    database: z.boolean(),
    signing_key: z.boolean(),
    custody: z.boolean(),
  }),
});

export interface RouteContract {
  method: 'GET' | 'POST';
  url: string;
  summary: string;
  tags: string[];
  auth: 'none' | 'user' | 'service' | 'client';
  responses: Record<number, { description: string; schema: z.ZodType; contentType?: string }>;
  headers?: Record<string, string>;
}

const problem = (description: string) => ({
  description,
  schema: Problem,
  contentType: 'application/problem+json',
});

export const ROUTES = {
  metadata: {
    method: 'GET',
    url: '/.well-known/oauth-authorization-server',
    summary: 'RFC 8414 authorization server metadata',
    tags: ['discovery'],
    auth: 'none',
    responses: {
      200: { description: 'Metadata', schema: AuthorizationServerMetadata },
      429: problem('Rate limited'),
    },
  },
  jwks: {
    method: 'GET',
    url: '/.well-known/jwks.json',
    summary: 'Published token verification keys (from signing_key_version)',
    tags: ['discovery'],
    auth: 'none',
    responses: { 200: { description: 'JWK set', schema: Jwks }, 429: problem('Rate limited') },
    headers: { 'cache-control': 'public, max-age=60, must-revalidate' },
  },
  authConfig: {
    method: 'GET',
    url: '/v1/auth/config',
    summary: 'Enabled CLI sign-in flows and IdP endpoints',
    tags: ['auth'],
    auth: 'none',
    responses: {
      200: { description: 'Auth config', schema: AuthConfig },
      429: problem('Rate limited'),
    },
  },
  healthz: {
    method: 'GET',
    url: '/healthz',
    summary: 'Liveness',
    tags: ['ops'],
    auth: 'none',
    responses: { 200: { description: 'Alive', schema: Health } },
  },
  readyz: {
    method: 'GET',
    url: '/readyz',
    summary: 'Readiness: database, an active signing key, no custody violation',
    tags: ['ops'],
    auth: 'none',
    responses: {
      200: { description: 'Ready', schema: Readiness },
      503: { description: 'Not ready', schema: Readiness },
    },
  },
} as const satisfies Record<string, RouteContract>;
