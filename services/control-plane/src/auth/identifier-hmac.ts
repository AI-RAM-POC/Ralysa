// `attempted_identifier_hmac` (F-002 design §3.5 [AR-17]; SEC-F002-30): when a sign-in fails
// before any subject was validated, the event carries an HMAC-SHA-256 of the UNVERIFIED
// `preferred_username` under the per-org key in OpenBao KV (`audit_hmac_path`), never the value
// itself, together with `identifier_verified: false`. Investigators can test a candidate name
// against it; the audit store never holds a name that anyone could have typed into a token.
//
// The key is read once and cached. If it can't be read, the field is left out: a denial is never
// held up by it.
import { createHmac } from 'node:crypto';
import type { SecretStore } from '@ralysa/secrets';

export const IDENTIFIER_MAX = 128;

export interface IdentifierHmac {
  /** The hex HMAC of `identifier` (truncated to 128 characters), or undefined. */
  of(identifier: string | undefined): Promise<string | undefined>;
}

export function createIdentifierHmac(secrets: SecretStore, path: string): IdentifierHmac {
  let key: Promise<string> | undefined;
  return {
    async of(identifier) {
      if (identifier === undefined || identifier === '') return undefined;
      key ??= secrets.get(path).then((secret) => secret.value);
      try {
        const value = await key;
        return createHmac('sha256', value)
          .update(Array.from(identifier).slice(0, IDENTIFIER_MAX).join(''), 'utf8')
          .digest('hex');
      } catch {
        key = undefined; // retried on the next failure
        return undefined;
      }
    },
  };
}
