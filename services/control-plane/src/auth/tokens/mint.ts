// Access-token minting through KeyCustody (F-002 design §3.2.1, §3.2.2; SEC-F002-19). The JOSE
// header is exactly {alg: ES256, typ: at+jwt, kid}: never jku, jwk, x5u, x5c or crit, and the kid
// is derived from the configured key name and the active version. Claims are validated against
// the protocol contract before signing, so a malformed token is never minted.
import {
  AccessTokenHeader,
  FORBIDDEN_JOSE_HEADERS,
  ServiceAccessTokenClaims,
  UserAccessTokenClaims,
} from '@ralysa/protocol/auth';
import type { SigningKeys } from './signing-keys.js';

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export type AccessClaims = UserAccessTokenClaims | ServiceAccessTokenClaims;

export async function mintAccessToken(keys: SigningKeys, claims: AccessClaims): Promise<string> {
  const schema = claims.token_use === 'service' ? ServiceAccessTokenClaims : UserAccessTokenClaims;
  const parsed = schema.safeParse(claims);
  if (!parsed.success) {
    throw new Error(
      `refusing to mint: invalid claims ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  const payload = b64u(utf8(JSON.stringify(parsed.data)));
  let signingInput = '';
  const { signature } = await keys.sign((kid) => {
    const header = AccessTokenHeader.parse({ alg: 'ES256', typ: 'at+jwt', kid });
    for (const name of FORBIDDEN_JOSE_HEADERS) {
      if (name in header) throw new Error(`forbidden JOSE header ${name}`);
    }
    signingInput = `${b64u(utf8(JSON.stringify(header)))}.${payload}`;
    return utf8(signingInput);
  });
  return `${signingInput}.${b64u(signature)}`;
}
