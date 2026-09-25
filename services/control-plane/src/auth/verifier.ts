// The control plane's verifier for tokens RTS minted (F-002 design §3.2.2, §3.2.6, §6.1). The
// control plane is a PEP, and since F-002-T12 (T11-11) it uses the same verifier as every other
// service, @ralysa/auth, with two local sources:
//
// - keys: its own JWKS rows (signing_key_version) through `keys.jwks()`, re-read at most once a
//   second, instead of fetching its own /.well-known/jwks.json;
// - revocation: read DIRECTLY from the database for every user token, never through the feed
//   [SEC-F002-18 d]. The session is checked before the user (a revoked or foreign session is
//   `session_revoked`, then `iat` before the user's `revoked_before` is `user_revoked`), as the
//   T08 verifier did. A database fault there is VerifierUnavailableError (503), like an
//   unreadable key set, never a token rejection (review of #32).
//
// Service tokens must belong to a registered service (`services[]`), else `wrong_token_use`.
import {
  type AccessTokenVerifier,
  type KeyResolver,
  type RevocationSource,
  type RevocationVerdict,
  type ServiceTokenVerifier,
  VerifierUnavailableError,
  createAccessTokenVerifier,
  createServiceTokenVerifier,
} from '@ralysa/auth';
import { createLocalJWKSet } from 'jose';
import { type Kysely, sql } from 'kysely';
import type { ServeConfig } from '../config/schema.js';
import { withOrg } from '../db/kysely.js';
import type { Database } from '../db/types.js';
import type { ClientRegistry } from './clients.js';
import type { SigningKeys } from './tokens/signing-keys.js';

export interface ControlPlaneVerifier {
  user: AccessTokenVerifier;
  service: ServiceTokenVerifier;
}

/** Revocation state read from cp.auth_session and cp.app_user under the org (§3.2.6). */
export function createDbRevocationSource(db: Kysely<Database>, orgId: string): RevocationSource {
  const readState = async (token: { sid: string; iat: number }) => {
    try {
      return await withOrg(
        db,
        orgId,
        async (trx) =>
          trx
            .selectFrom('cp.auth_session as s')
            .innerJoin('cp.app_user as u', 'u.id', 's.user_id')
            .select([
              's.status',
              's.user_id',
              sql<boolean>`u.revoked_before is not null and to_timestamp(${token.iat}) < u.revoked_before`.as(
                'userRevoked',
              ),
            ])
            .where('s.id', '=', token.sid)
            .executeTakeFirst(),
        { readOnly: true },
      );
    } catch {
      throw new VerifierUnavailableError('the revocation state could not be read');
    }
  };
  return {
    async check(token): Promise<RevocationVerdict> {
      const state = await readState(token);
      if (state === undefined || state.status !== 'active' || state.user_id !== token.sub) {
        return 'session_revoked';
      }
      return state.userRevoked ? 'user_revoked' : 'ok';
    },
  };
}

/** The published JWKS rows as a jose key resolver, re-read at most every `maxAgeMs`. */
export function createOwnKeySet(
  keys: Pick<SigningKeys, 'jwks'>,
  now: () => number = () => Date.now(),
  maxAgeMs = 1_000,
): KeyResolver {
  let cached: { at: number; set: ReturnType<typeof createLocalJWKSet> } | undefined;
  return async (header, token) => {
    if (cached === undefined || now() - cached.at > maxAgeMs) {
      cached = { at: now(), set: createLocalJWKSet(await keys.jwks()) };
    }
    return cached.set(header, token);
  };
}

export function createControlPlaneVerifier(deps: {
  config: Pick<ServeConfig, 'public_base_url' | 'signing_key' | 'org'>;
  keys: Pick<SigningKeys, 'jwks'>;
  db: Kysely<Database>;
  clients: ClientRegistry;
}): ControlPlaneVerifier {
  const issuer = deps.config.public_base_url.replace(/\/+$/, '');
  // Token times and the key-set cache use the process clock, as the T08 verifier did.
  const common = {
    issuer,
    // Never fetched: the key set below is used instead.
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    kidPrefix: deps.config.signing_key,
    orgId: deps.config.org.id,
    keySet: createOwnKeySet(deps.keys),
  };
  return {
    user: createAccessTokenVerifier({
      ...common,
      audience: 'control-plane',
      revocation: createDbRevocationSource(deps.db, deps.config.org.id),
    }),
    service: createServiceTokenVerifier({
      ...common,
      isRegistered: (clientId) => deps.clients.service(clientId) !== undefined,
    }),
  };
}
