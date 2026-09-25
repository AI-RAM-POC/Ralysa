// The client_credentials grant with RFC 7523 client assertions (F-002 design §3.2.7; AC-11;
// SEC-F002-22). The service signs an assertion through its own Transit key; RTS verifies it
// against the public key of that key version, but only versions OpenBao still treats as live
// (at or above both min_available_version and min_decryption_version), cached per key for at most
// 60 s. Checks: registered client, iss = sub = client, aud = the token endpoint URL, a lifetime
// (exp - iat) of at most 60 s, exp at most 60 s ahead of our clock, iat not in the future, and a
// jti never seen before. The replay row lives until the assertion can no longer be accepted on any
// clock: exp + skew + a 60 s margin for clock drift between replicas and the database (review of
// #26, B2). Then a 5-minute service token (sub = svc:<name>).
//
// A service key that violates custody (exportable or plaintext backup) verifies nothing, and
// secret.custody_violation is recorded for it (review of #26).
import { createHash } from 'node:crypto';
import { CustodyViolationError } from '@ralysa/secrets';
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
import { systemEvent } from '../../audit/events.js';
import { withOrg } from '../../db/kysely.js';
import { OAuthProblem } from '../../http/errors.js';
import { authEvent } from '../audit-events.js';
import type { ServiceClient } from '../clients.js';
import type { RtsDeps } from '../deps.js';
import { mintAccessToken } from '../tokens/mint.js';
import type { GrantContext, TokenResult } from './refresh-token.js';

const MAX_LIFETIME_S = TOKEN_LIFETIMES.clientAssertionMaxSeconds;
const skew = TOKEN_LIFETIMES.verifierClockSkewSeconds;
/** How long past exp + skew a replay row is kept (clock drift between replicas and the DB). */
export const REPLAY_MARGIN_S = 60;

type Key = Awaited<ReturnType<typeof importJWK>>;

/** A cached key list is re-read after this, so a version retired in OpenBao stops verifying. */
export const SERVICE_KEY_CACHE_TTL_MS = 60_000;
/** An unknown version triggers a re-read at most this often per key (a bad `kid` can't hammer OpenBao). */
export const SERVICE_KEY_MISS_COOLDOWN_MS = 5_000;

/**
 * Public keys per (transit key, version) [SEC-F002-22]. The whole list for a key is re-read from
 * OpenBao when it is older than SERVICE_KEY_CACHE_TTL_MS, or on an unknown version after the
 * cooldown. Versions below min_available_version (trimmed) or min_decryption_version (no longer
 * verifying at Transit) are retired, so a retired version is refused at most one TTL after it is
 * retired. A key that violates custody caches as "no versions" and is reported once per flag set.
 */
export function createServiceKeyCache(
  deps: Pick<RtsDeps, 'custody'> & {
    onCustodyViolation?: (error: CustodyViolationError) => Promise<void>;
  },
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
      const versions = new Map<number, Key>();
      try {
        const described = await deps.custody.describe(transitKey);
        const from = Math.max(1, described.minAvailableVersion, described.minDecryptionVersion);
        for (const v of described.versions) {
          if (v.version >= from) versions.set(v.version, await importJWK({ ...v.jwk }, 'ES256'));
        }
      } catch (error) {
        if (!(error instanceof CustodyViolationError)) throw error;
        await deps.onCustodyViolation?.(error);
      }
      entry = { at: now(), versions };
      cache.set(transitKey, entry);
    }
    return entry?.versions.get(version);
  };
}

/** secret.custody_violation for a service assertion key, once per key and flag set until it lands. */
export function serviceKeyViolationRecorder(deps: Pick<RtsDeps, 'writer' | 'config'>) {
  const recorded = new Set<string>();
  return async (error: CustodyViolationError): Promise<void> => {
    const flag =
      error.exportable && error.allowPlaintextBackup
        ? 'exportable_and_plaintext_backup'
        : error.exportable
          ? 'exportable'
          : 'allow_plaintext_backup';
    const once = `${error.key}|${flag}`;
    if (recorded.has(once)) return;
    await deps.writer.writeOrSpool(deps.config.org.id, [
      systemEvent({
        action: 'secret.custody_violation',
        outcome: 'error',
        service: 'rts',
        reasonCode: flag,
        details: {
          key: error.key,
          flag,
          exportable: error.exportable,
          allow_plaintext_backup: error.allowPlaintextBackup,
          key_replaced: false,
          purpose: 'service_assertion',
        },
      }),
    ]);
    recorded.add(once);
  };
}

/**
 * The assertion's time rules, on the verifier's clock (seconds). jwtVerify has already checked
 * exp and nbf with the skew; these bound how far ahead exp may be and how long the assertion
 * lives, so a replay row outliving exp + skew covers every assertion accepted.
 */
export function assertionTimeProblem(
  claims: { iat?: number | undefined; exp?: number | undefined },
  nowS: number,
): string | undefined {
  const { iat, exp } = claims;
  if (typeof iat !== 'number' || typeof exp !== 'number') return 'iat and exp required';
  if (iat > nowS + skew) return 'iat in the future';
  if (exp - iat > MAX_LIFETIME_S) return 'lifetime over 60 s';
  if (exp > nowS + MAX_LIFETIME_S) return 'exp too far ahead';
  return undefined;
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
    const problem = assertionTimeProblem(payload, Date.now() / 1000);
    if (problem !== undefined) {
      throw new AssertionRejected(
        problem === 'iat in the future' ? 'issued_in_future' : 'malformed',
        problem,
      );
    }
    const jtiHash = createHash('sha256')
      .update(`${client.clientId}\u0000${String(payload.jti)}`)
      .digest();
    const expS = payload.exp ?? 0;
    const fresh = await withOrg(deps.db, deps.config.org.id, (trx) =>
      trx
        .insertInto('cp.client_assertion_replay')
        .values({
          jti_hash: jtiHash,
          org_id: deps.config.org.id,
          // Until the assertion can't be accepted anywhere: exp + skew, plus the drift margin.
          expires_at: sql<Date>`to_timestamp(${expS}) + make_interval(secs => ${skew + REPLAY_MARGIN_S})`,
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
