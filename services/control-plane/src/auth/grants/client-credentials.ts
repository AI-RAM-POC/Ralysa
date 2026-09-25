// The client_credentials grant with RFC 7523 client assertions (F-002 design §3.2.7; AC-11;
// SEC-F002-22). The service signs an assertion through its own Transit key; RTS verifies it
// against the public key of that key version, but only versions OpenBao still lists as available
// (non-retired, min_available_version), cached per version for at most 60 s. Checks: registered client,
// iss = sub = client, aud = the token endpoint URL, exp at most 60 s ahead, a jti never seen
// before (replay cache for 120 s). Then a 5-minute service token (sub = svc:<name>).
import { createHash } from 'node:crypto';
import {
  ClientCredentialsRequest,
  FORBIDDEN_JOSE_HEADERS,
  TOKEN_LIFETIMES,
  type TokenRejectReason,
} from '@ralysa/protocol/auth';
import { uuidv7 } from '@ralysa/protocol/common';
import {
  type JWTPayload,
  decodeJwt,
  decodeProtectedHeader,
  errors,
  importJWK,
  jwtVerify,
} from 'jose';
import { sql } from 'kysely';
import { withOrg } from '../../db/kysely.js';
import { OAuthProblem } from '../../http/errors.js';
import { authEvent } from '../audit-events.js';
import type { ServiceClient } from '../clients.js';
import type { RtsDeps } from '../deps.js';
import { mintAccessToken } from '../tokens/mint.js';
import type { GrantContext, TokenResult } from './refresh-token.js';

const MAX_AHEAD_S = TOKEN_LIFETIMES.clientAssertionMaxSeconds;
const skew = TOKEN_LIFETIMES.verifierClockSkewSeconds;

type Key = Awaited<ReturnType<typeof importJWK>>;

/** A cached key list is re-read after this, so a version retired in OpenBao stops verifying. */
export const SERVICE_KEY_CACHE_TTL_MS = 60_000;
/** An unknown version triggers a re-read at most this often per key (a bad `kid` can't hammer OpenBao). */
export const SERVICE_KEY_MISS_COOLDOWN_MS = 5_000;

/**
 * Public keys per (transit key, version) [SEC-F002-22]. The whole list for a key is re-read from
 * OpenBao when it is older than SERVICE_KEY_CACHE_TTL_MS, or on an unknown version after the
 * cooldown. `describe` lists only versions from min_available_version, so a retired version is
 * refused at most one TTL after it is retired.
 */
export function createServiceKeyCache(
  deps: Pick<RtsDeps, 'custody'>,
  options: { now?: () => number } = {},
) {
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { at: number; versions: Map<number, Key> }>();
  return async (transitKey: string, version: number): Promise<Key | undefined> => {
    let entry = cache.get(transitKey);
    const age = entry === undefined ? Infinity : now() - entry.at;
    const stale =
      age > SERVICE_KEY_CACHE_TTL_MS ||
      (entry?.versions.has(version) !== true && age > SERVICE_KEY_MISS_COOLDOWN_MS);
    if (stale) {
      const described = await deps.custody.describe(transitKey);
      const versions = new Map<number, Key>();
      for (const v of described.versions) {
        versions.set(v.version, await importJWK({ ...v.jwk }, 'ES256'));
      }
      entry = { at: now(), versions };
      cache.set(transitKey, entry);
    }
    return entry?.versions.get(version);
  };
}

class AssertionRejected extends Error {
  constructor(
    readonly reason: TokenRejectReason,
    readonly detail: string,
  ) {
    super(detail);
  }
}

export async function clientCredentialsGrant(
  deps: RtsDeps,
  body: unknown,
  ctx: GrantContext,
  keyFor: ReturnType<typeof createServiceKeyCache>,
): Promise<TokenResult> {
  const parsed = ClientCredentialsRequest.safeParse(body);
  if (!parsed.success) throw new OAuthProblem({ error: 'invalid_request' });
  const tokenEndpoint = `${deps.config.public_base_url.replace(/\/+$/, '')}/oauth2/token`;
  let client: ServiceClient | undefined;
  let payload: JWTPayload;
  try {
    let unverified: JWTPayload;
    let header;
    try {
      header = decodeProtectedHeader(parsed.data.client_assertion);
      unverified = decodeJwt(parsed.data.client_assertion);
    } catch {
      throw new AssertionRejected('malformed', 'unparseable assertion');
    }
    if (header.alg !== 'ES256') throw new AssertionRejected('wrong_alg', 'alg');
    if (FORBIDDEN_JOSE_HEADERS.some((name) => name in header)) {
      throw new AssertionRejected('forbidden_header', 'forbidden header');
    }
    client = typeof unverified.iss === 'string' ? deps.clients.service(unverified.iss) : undefined;
    if (client === undefined) throw new AssertionRejected('unknown_issuer', 'unregistered client');
    if (parsed.data.client_id !== undefined && parsed.data.client_id !== client.clientId) {
      throw new AssertionRejected('malformed', 'client_id differs from the assertion');
    }
    const kid = typeof header.kid === 'string' ? /^(.+)\.v([1-9][0-9]*)$/.exec(header.kid) : null;
    if (kid === null || kid[1] !== client.transitKey)
      throw new AssertionRejected('unknown_kid', 'kid');
    const key = await keyFor(client.transitKey, Number(kid[2]));
    if (key === undefined)
      throw new AssertionRejected('unknown_kid', 'retired or unknown key version');
    try {
      ({ payload } = await jwtVerify(parsed.data.client_assertion, key, {
        issuer: client.clientId,
        subject: client.clientId,
        audience: tokenEndpoint,
        algorithms: ['ES256'],
        clockTolerance: skew,
        requiredClaims: ['exp', 'jti', 'iat'],
      }));
    } catch (error) {
      if (error instanceof errors.JWSSignatureVerificationFailed)
        throw new AssertionRejected('bad_signature', 'signature');
      if (error instanceof errors.JWTExpired) throw new AssertionRejected('expired', 'expired');
      if (error instanceof errors.JWTClaimValidationFailed && error.claim === 'aud') {
        throw new AssertionRejected('wrong_audience', 'audience');
      }
      throw new AssertionRejected('malformed', 'claims');
    }
    const now = Date.now() / 1000;
    if ((payload.exp ?? 0) > now + MAX_AHEAD_S + skew)
      throw new AssertionRejected('malformed', 'exp too far ahead');
    if ((payload.iat ?? 0) > now + skew) throw new AssertionRejected('issued_in_future', 'iat');
    const jtiHash = createHash('sha256')
      .update(`${client.clientId}\u0000${String(payload.jti)}`)
      .digest();
    const fresh = await withOrg(deps.db, deps.config.org.id, (trx) =>
      trx
        .insertInto('cp.client_assertion_replay')
        .values({
          jti_hash: jtiHash,
          org_id: deps.config.org.id,
          expires_at: sql<Date>`clock_timestamp() + interval '120 seconds'`,
        })
        .onConflict((oc) => oc.column('jti_hash').doNothing())
        .returning('jti_hash')
        .executeTakeFirst(),
    );
    if (fresh === undefined) throw new AssertionRejected('malformed', 'jti replay');
  } catch (error) {
    if (!(error instanceof AssertionRejected)) throw error;
    // Recorded through the rejection aggregator; the org is config's, never the assertion's.
    deps.rejections.record({
      orgId: deps.config.org.id,
      clientIp: ctx.clientIp,
      reason: error.reason,
      audience: 'rts-token-endpoint',
      traceId: ctx.traceId,
    });
    throw new OAuthProblem({ error: 'invalid_client' }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const jti = uuidv7();
  const accessToken = await mintAccessToken(deps.keys, {
    iss: deps.config.public_base_url.replace(/\/+$/, ''),
    aud: 'control-plane',
    sub: client.clientId,
    client_id: client.clientId,
    tid: deps.config.org.id,
    token_use: 'service',
    iat: now,
    nbf: now,
    exp: now + deps.config.tokens.service_ttl_s,
    jti,
  });
  void deps.writer
    .writeOrSpool(deps.config.org.id, [
      authEvent({
        action: 'auth.token.issued',
        outcome: 'success',
        traceId: ctx.traceId,
        service: client.name,
        details: { audience: 'control-plane', grant_type: 'client_credentials', jti },
      }),
    ])
    .catch(() => undefined);
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: deps.config.tokens.service_ttl_s,
  };
}
