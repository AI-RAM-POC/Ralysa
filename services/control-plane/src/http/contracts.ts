// Route contracts: method, path and response schemas for every route of the serve process
// (F-002 design §3.1, §3.10). The app registers its routes with these schemas and the OpenAPI
// document is generated from the same objects, so what is validated is what is published. Later
// tasks append their routes here.
import {
  AuthorizationServerMetadata,
  OAuthError,
  RevokeRequest,
  TokenRequest,
  TokenResponse,
} from '@ralysa/protocol/auth';
import { Problem } from '@ralysa/protocol/common';
import {
  AuthConfig,
  GovernanceState,
  Me,
  Principal,
  SignInFailureReport,
} from '@ralysa/protocol/control-plane';
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

export interface RouteParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  description: string;
  schema: z.ZodType;
}

export interface RouteContract {
  method: 'GET' | 'POST';
  /** Fastify syntax (`:name`); the OpenAPI document writes `{name}`. */
  url: string;
  parameters?: RouteParameter[];
  request?: { contentType: string; schema: z.ZodType };
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

const oauthError = (description: string) => ({ description, schema: OAuthError });

/** RFC 7009 §2.2: an empty JSON object, whether or not the token was known. */
export const RevokeResponse = z.strictObject({});

/** 202 for an accepted report: an empty object. */
export const Accepted = z.strictObject({});

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
  token: {
    method: 'POST',
    url: '/oauth2/token',
    summary:
      'Token endpoint: token exchange of an IdP device-flow access token (RFC 8693), refresh_token and client_credentials (private_key_jwt); authorization_code arrives with the second part of F-002-T10. No client secret is ever accepted.',
    tags: ['oauth'],
    auth: 'client',
    request: { contentType: 'application/x-www-form-urlencoded', schema: TokenRequest },
    responses: {
      200: { description: 'Tokens', schema: TokenResponse },
      400: oauthError(
        'invalid_request, invalid_grant, invalid_scope, unauthorized_client (device code switched off), access_denied (sign-in refused by policy) or unsupported_grant_type',
      ),
      401: oauthError('invalid_client'),
      429: oauthError('Rate limited'),
      503: oauthError(
        'temporarily_unavailable (IdP directory, token signing or audit unavailable; a refresh token is not consumed)',
      ),
    },
    headers: { 'cache-control': 'no-store' },
  },
  revoke: {
    method: 'POST',
    url: '/oauth2/revoke',
    summary: "RFC 7009 revocation = sign-out: revokes the refresh token's whole session",
    tags: ['oauth'],
    auth: 'client',
    request: { contentType: 'application/x-www-form-urlencoded', schema: RevokeRequest },
    responses: {
      200: { description: 'Revoked, or the token was unknown (RFC 7009)', schema: RevokeResponse },
      400: oauthError('invalid_request'),
      401: oauthError('invalid_client'),
      429: oauthError('Rate limited'),
    },
    headers: { 'cache-control': 'no-store' },
  },
  signInFailures: {
    method: 'POST',
    url: '/v1/auth/sign-in-failures',
    summary:
      'Client-reported IdP-side failures of the device flow (AC-4): audited as auth.sign_in failure, idempotent per attempt_id, rate-limited and aggregated',
    tags: ['auth'],
    auth: 'none',
    request: { contentType: 'application/json', schema: SignInFailureReport },
    responses: {
      202: { description: 'Accepted (also for a repeated attempt_id)', schema: Accepted },
      400: problem('Invalid report'),
      429: problem('Rate limited'),
    },
  },
  me: {
    method: 'GET',
    url: '/v1/me',
    summary: "The signed-in user, the calling session's roles and the user's groups",
    tags: ['directory'],
    auth: 'user',
    responses: {
      200: { description: 'The user', schema: Me },
      401: problem('Missing, invalid or revoked access token'),
    },
  },
  principal: {
    method: 'GET',
    url: '/v1/internal/principals/:user_id',
    summary: 'Groups, roles and status of a user (service token)',
    tags: ['internal'],
    auth: 'service',
    parameters: [
      {
        name: 'user_id',
        in: 'path',
        required: true,
        description: 'Ralysa user id',
        schema: z.uuid(),
      },
    ],
    responses: {
      200: { description: 'The principal', schema: Principal },
      400: problem('Invalid user id'),
      401: problem('Missing or invalid service token'),
      404: problem('No such user'),
    },
  },
  governance: {
    method: 'GET',
    url: '/v1/internal/governance',
    summary: 'Revocations, kill-switch state and epoch for every PEP (service token; G-1)',
    tags: ['internal'],
    auth: 'service',
    parameters: [
      {
        name: 'since',
        in: 'query',
        required: false,
        description:
          'The cursor of the previous response; without it the feed covers the maximum access-token TTL + 5 min',
        schema: z.iso.datetime(),
      },
    ],
    responses: {
      200: { description: 'Governance state', schema: GovernanceState },
      400: problem('Invalid cursor'),
      401: problem('Missing or invalid service token'),
    },
    headers: { 'cache-control': 'no-store' },
  },
} as const satisfies Record<string, RouteContract>;
