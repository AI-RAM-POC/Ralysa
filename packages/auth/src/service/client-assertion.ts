// RFC 7523 client assertions for service identity (F-002 design §3.2.7; AD-1; SR-07). A service
// signs its assertion through its OWN non-exportable Transit key (`ralysa-svc-<name>`) after its
// workload login to OpenBao; no static service secret exists. RTS checks: `iss` = `sub` = the
// registered client id, `aud` = its token endpoint URL, `exp - iat` ≤ 60 s, `exp` ≤ 60 s ahead,
// a fresh `jti`, ES256, a `kid` of `<transit key>.v<version>` on a non-retired version, and no
// `jku`/`jwk`/`x5u`/`x5c`/`crit` header.
import { base64url, randomUuid, utf8 } from '../platform.js';

/**
 * Signs a JWS signing input with the service's key. `build` receives the `kid` of the version that
 * will sign, so the header can't name another version than the signature (the T07-7 pattern).
 */
export interface AssertionSigner {
  sign(build: (kid: string) => Uint8Array): Promise<{ input: Uint8Array; signature: Uint8Array }>;
}

/**
 * The part of `@ralysa/secrets` `KeyCustody` a Transit-backed signer needs; the OpenBao adapter
 * and the in-memory double both satisfy it. `describe` refuses a key whose `exportable` or
 * `allow_plaintext_backup` is set, so a custody violation stops assertions (SEC-F002-11).
 */
export interface TransitSigning {
  describe(key: string): Promise<{ latestVersion: number }>;
  /** Raw JWS signature bytes (ES256: r‖s, 64 bytes). */
  sign(key: string, version: number, signingInput: Uint8Array): Promise<Uint8Array>;
}

/** A signer over the service's Transit key `ralysa-svc-<name>`, signing with its latest version. */
export function createTransitAssertionSigner(opts: {
  custody: TransitSigning;
  transitKey: string;
}): AssertionSigner {
  if (!/^ralysa-svc-[a-z][a-z0-9-]{1,40}$/.test(opts.transitKey)) {
    throw new Error('transitKey must be ralysa-svc-<name>');
  }
  return {
    async sign(build) {
      const { latestVersion } = await opts.custody.describe(opts.transitKey);
      if (!Number.isSafeInteger(latestVersion) || latestVersion < 1) {
        throw new Error('transit key has no usable version');
      }
      const input = build(`${opts.transitKey}.v${String(latestVersion)}`);
      const signature = await opts.custody.sign(opts.transitKey, latestVersion, input);
      if (signature.length !== 64) throw new Error('ES256 signature must be 64 bytes (r‖s)');
      return { input, signature };
    },
  };
}

/** Assertion lifetime: below RTS's 60 s cap, with room for a few seconds of clock drift. */
export const ASSERTION_LIFETIME_S = 50;

/** Builds and signs one compact client assertion (single use: a fresh `jti` every time). */
export async function createClientAssertion(opts: {
  clientId: string;
  /** RTS's token endpoint URL exactly as RTS names it (its `public_base_url` + `/oauth2/token`). */
  audience: string;
  signer: AssertionSigner;
  nowSeconds?: number;
}): Promise<string> {
  const iat = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload = {
    iss: opts.clientId,
    sub: opts.clientId,
    aud: opts.audience,
    iat,
    exp: iat + ASSERTION_LIFETIME_S,
    jti: randomUuid(),
  };
  const encode = (value: unknown) => base64url(utf8(JSON.stringify(value)));
  const { input, signature } = await opts.signer.sign((kid) =>
    utf8(`${encode({ alg: 'ES256', typ: 'JWT', kid })}.${encode(payload)}`),
  );
  let text = '';
  for (const byte of input) text += String.fromCharCode(byte);
  return `${text}.${base64url(signature)}`;
}
