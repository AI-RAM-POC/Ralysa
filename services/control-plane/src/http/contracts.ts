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
import { Outcome } from '@ralysa/protocol/audit';
import {
  AuditQueryResponse,
  AuthConfig,
  ClientEventsRequest,
  ClientEventsResponse,
  ClientEventsUnavailable,
  GovernanceState,
  Me,
  Principal,
  ServiceEventsRequest,
  ServiceEventsResponse,
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
  authorize: {
    method: 'GET',
    url: '/oauth2/authorize',
    summary:
      'Flow B leg 1 (/login --browser): sets the browser-binding cookie and redirects to the IdP. An unknown client or a non-loopback redirect_uri is never redirected (RFC 6749 §4.1.2.1).',
    tags: ['oauth'],
    auth: 'none',
    parameters: [
      {
        name: 'response_type',
        in: 'query',
        required: true,
        description: '`code`',
        schema: z.literal('code'),
      },
      {
        name: 'client_id',
        in: 'query',
        required: true,
        description: '`ralysa-cli`',
        schema: z.literal('ralysa-cli'),
      },
      {
        name: 'redirect_uri',
        in: 'query',
        required: true,
        description: 'IP-literal loopback, any port, path /callback (RFC 8252 §7.3)',
        schema: z.string().max(64),
      },
      {
        name: 'code_challenge',
        in: 'query',
        required: true,
        description: 'S256 PKCE challenge',
        schema: z.string().max(43),
      },
      {
        name: 'code_challenge_method',
        in: 'query',
        required: true,
        description: '`S256`',
        schema: z.literal('S256'),
      },
      {
        name: 'state',
        in: 'query',
        required: true,
        description: "The client's state (16–128 characters)",
        schema: z.string().min(16).max(128),
      },
    ],
    responses: {
      302: {
        description: 'To the IdP, or back to the loopback with an OAuth error',
        schema: z.string().max(0),
        contentType: 'text/plain',
      },
      400: {
        description: 'Plain-text en/ar error: invalid client or redirect URI',
        schema: z.string(),
        contentType: 'text/plain; charset=utf-8',
      },
      429: oauthError('Rate limited'),
    },
    headers: { 'cache-control': 'no-store' },
  },
  idpCallback: {
    method: 'GET',
    url: '/oauth2/idp/callback',
    summary:
      "Flow B leg 2: the IdP's redirect. Consumes the stored request, checks the browser-binding cookie, redeems the IdP code and redirects to the loopback with a single-use rly_ac_ code (or an OAuth error).",
    tags: ['oauth'],
    auth: 'none',
    parameters: [
      {
        name: 'state',
        in: 'query',
        required: true,
        description: "RTS's state toward the IdP",
        schema: z.string().max(512),
      },
      {
        name: 'code',
        in: 'query',
        required: false,
        description: "The IdP's authorization code",
        schema: z.string(),
      },
      {
        name: 'error',
        in: 'query',
        required: false,
        description: "The IdP's error",
        schema: z.string(),
      },
    ],
    responses: {
      302: {
        description:
          'To the loopback with `code` and `state`, or `error` and `error_description` (a sign-in reason)',
        schema: z.string().max(0),
        contentType: 'text/plain',
      },
      400: {
        description: 'Plain-text en/ar error: unknown request or browser binding failed',
        schema: z.string(),
        contentType: 'text/plain; charset=utf-8',
      },
      429: oauthError('Rate limited'),
    },
    headers: { 'cache-control': 'no-store' },
  },
  token: {
    method: 'POST',
    url: '/oauth2/token',
    summary:
      'Token endpoint: authorization_code with PKCE (flow B), token exchange of an IdP device-flow access token (RFC 8693), refresh_token and client_credentials (private_key_jwt). No client secret is ever accepted.',
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
    summary:
      "Groups, directory roles and status of a user; with sid, that session's roles ∩ current memberships (service token)",
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
      {
        name: 'sid',
        in: 'query',
        required: false,
        description:
          "The access token's sid. When given, the answer adds session_roles (the session's roles ∩ the current memberships); PEPs authorize privileged actions on session_roles, never on roles (rev 10, SEC-F002-42)",
        schema: z.uuid(),
      },
    ],
    responses: {
      200: { description: 'The principal', schema: Principal },
      400: problem('Invalid user id or sid'),
      401: problem('Missing or invalid service token'),
      403: problem("The sid is unknown, another user's, revoked, pending or expired"),
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
  serviceEvents: {
    method: 'POST',
    url: '/v1/audit/events',
    summary:
      "Service audit ingestion (AC-11): 1–100 events, each within the calling service's action allow-list; source from the service token, attestation server, ts from the database clock. A plain INSERT per event in a savepoint (duplicate event_id = duplicate). auth.token_rejected reports are aggregated per client network (status aggregated).",
    tags: ['audit'],
    auth: 'service',
    request: { contentType: 'application/json', schema: ServiceEventsRequest },
    responses: {
      201: {
        description: 'Stored, duplicate or aggregated, per event',
        schema: ServiceEventsResponse,
      },
      400: problem('Malformed JSON'),
      401: problem('Missing or invalid service token'),
      403: problem(
        'A user token, an unregistered service, or an action outside the allow-list (audited as audit.ingest_rejected)',
      ),
      413: problem('Body over 256 KB'),
      422: problem('Schema, I-JSON details, outcome rule or unknown user actor'),
      503: problem('audit_unavailable: the insert failed or exceeded 250 ms'),
    },
  },
  clientEvents: {
    method: 'POST',
    url: '/v1/audit/client-events',
    summary:
      "Client-attested local-tool audit (AC-16): the actor, org, source and ts come from the token and the server; server-issued sessions bound to the token's sid; client_seq gaps; each tool.call.requested is answered with an intent ack (refused while a kill-switch applies).",
    tags: ['audit'],
    auth: 'user',
    request: { contentType: 'application/json', schema: ClientEventsRequest },
    responses: {
      201: { description: 'Stored or duplicate, with intent acks', schema: ClientEventsResponse },
      400: problem('Malformed JSON'),
      401: problem('Missing, invalid or revoked access token'),
      409: problem(
        'A new session not opened by session.started, or an unknown, foreign or ended session, or a client_seq at or below the last one outside an open gap',
      ),
      413: problem('An event over 4 KB (canonical form) or a body over 256 KB'),
      422: problem('Schema, allow-list, reserved details key or I-JSON'),
      423: {
        description:
          'A kill-switch covers an intent: halted, ack false, stored as tool.call.denied',
        schema: ClientEventsResponse,
      },
      429: problem('More than 20 open sessions for the auth session, or 600 events a minute'),
      503: {
        description: 'audit_unavailable: nothing stored, every intent ack false',
        schema: ClientEventsUnavailable,
        contentType: 'application/problem+json',
      },
    },
  },
  auditQuery: {
    method: 'GET',
    url: '/v1/audit/events',
    summary:
      'Audit query (AC-12): session role platform_admin and a current admin-group membership; audit.query is committed before any result is read; keyset paging on (ts, event_id), not a snapshot: an event committed late with a ts before the last key already read is not on the next page, and re-running the query over the same range returns it',
    tags: ['audit'],
    auth: 'user',
    parameters: [
      {
        name: 'from',
        in: 'query',
        required: true,
        description: 'Inclusive start (RFC 3339)',
        schema: z.iso.datetime(),
      },
      {
        name: 'to',
        in: 'query',
        required: true,
        description: 'Exclusive end (RFC 3339), at most 31 days after from',
        schema: z.iso.datetime(),
      },
      {
        name: 'user_id',
        in: 'query',
        required: false,
        description: 'Actor user id',
        schema: z.uuid(),
      },
      {
        name: 'action',
        in: 'query',
        required: false,
        description: 'Exact action',
        schema: z.string().max(100),
      },
      { name: 'outcome', in: 'query', required: false, description: 'Outcome', schema: Outcome },
      {
        name: 'limit',
        in: 'query',
        required: false,
        description: '1–500, default 100',
        schema: z.string().regex(/^(?:[1-9]\d?|[1-4]\d\d|500)$/),
      },
      {
        name: 'cursor',
        in: 'query',
        required: false,
        description: 'next_cursor of the previous page',
        schema: z.string().max(256),
      },
    ],
    responses: {
      200: { description: 'A page of events with their seals', schema: AuditQueryResponse },
      400: problem('Invalid filters, range or cursor'),
      401: problem('Missing, invalid or revoked access token'),
      403: problem('Not a platform admin (audited as audit.query denied)'),
      503: problem('audit_unavailable: audit.query could not be committed'),
    },
    headers: { 'cache-control': 'no-store' },
  },
} as const satisfies Record<string, RouteContract>;
