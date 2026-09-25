// Transit KeyCustody (F-002 design §3.2.4, §3.7; [Transit API](https://openbao.org/api-docs/secret/transit/)).
// `describe` reads key metadata and public keys and refuses a key that is exportable or allows a
// plaintext backup [SEC-F002-11]; `sign` uses an explicit `key_version` and JWS marshaling, so the
// signature is already the raw r‖s a JWS needs.
import { CustodyViolationError, SecretsError } from '../errors.js';
import { fromBase64, subtle, toBase64 } from '../platform.js';
import type { KeyCustody, KeyDescription, PublicJwk, PublicKeyVersion } from '../ports.js';
import type { AuthedBao } from './auth.js';
import { assertApiPath, record, replyError } from './http.js';

const KEY_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

function assertKeyName(key: string): void {
  if (!KEY_NAME.test(key))
    throw new SecretsError('config', `invalid transit key name ${JSON.stringify(key)}`);
}

/** PEM SPKI (P-256) → public JWK through WebCrypto. */
export async function pemToJwk(pem: string): Promise<PublicJwk> {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  const der = fromBase64(body);
  const key = await subtle().importKey('spki', der, { name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'verify',
  ]);
  const jwk = await subtle().exportKey('jwk', key);
  if (
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string'
  ) {
    throw new SecretsError('invalid_response', 'transit public key is not P-256');
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/** Checks a key's metadata; shared with the in-memory double so both enforce the same rules. */
export function checkCustody(
  key: string,
  meta: { type: unknown; exportable: unknown; allowPlaintextBackup: unknown },
): void {
  if (meta.exportable !== false || meta.allowPlaintextBackup !== false) {
    throw new CustodyViolationError(key, {
      exportable: meta.exportable !== false,
      allowPlaintextBackup: meta.allowPlaintextBackup !== false,
    });
  }
  if (meta.type !== 'ecdsa-p256') {
    throw new SecretsError(
      'unsupported_key',
      `transit key ${key} is ${String(meta.type)}, not ecdsa-p256`,
    );
  }
}

export function createTransitKeyCustody(bao: AuthedBao, mount = 'transit'): KeyCustody {
  assertApiPath(mount);
  return {
    async describe(key): Promise<KeyDescription> {
      assertKeyName(key);
      const reply = await bao.request('GET', `${mount}/keys/${key}`);
      if (reply.status !== 200) throw replyError(reply, `describe ${key}`);
      const data = record(reply.body?.data) ?? {};
      checkCustody(key, {
        type: data.type,
        exportable: data.exportable,
        allowPlaintextBackup: data.allow_plaintext_backup,
      });
      const latest = data.latest_version;
      const minAvailable = data.min_available_version;
      const keys = record(data.keys);
      if (typeof latest !== 'number' || typeof minAvailable !== 'number' || keys === undefined) {
        throw new SecretsError('invalid_response', `describe ${key}: missing versions`);
      }
      const versions: PublicKeyVersion[] = [];
      for (let version = Math.max(1, minAvailable); version <= latest; version++) {
        const entry = record(keys[String(version)]);
        const pem = entry?.public_key;
        const created = entry?.creation_time;
        if (typeof pem !== 'string' || typeof created !== 'string') {
          throw new SecretsError(
            'invalid_response',
            `describe ${key}: version ${String(version)} has no public key`,
          );
        }
        versions.push({ version, jwk: await pemToJwk(pem), createdAt: new Date(created) });
      }
      return {
        latestVersion: latest,
        minAvailableVersion: minAvailable,
        exportable: false,
        allowPlaintextBackup: false,
        versions,
      };
    },

    async sign(key, version, signingInput) {
      assertKeyName(key);
      if (!Number.isInteger(version) || version < 1) {
        throw new SecretsError('config', `sign ${key}: invalid key version`);
      }
      const reply = await bao.request('POST', `${mount}/sign/${key}/sha2-256`, {
        input: toBase64(signingInput),
        key_version: version,
        marshaling_algorithm: 'jws',
      });
      if (reply.status !== 200) throw replyError(reply, `sign ${key}`);
      const signature = record(reply.body?.data)?.signature;
      const match =
        typeof signature === 'string' ? /^vault:v(\d+):([A-Za-z0-9_-]+)$/.exec(signature) : null;
      if (match === null || Number(match[1]) !== version) {
        throw new SecretsError(
          'invalid_response',
          `sign ${key}: unexpected signature format or version`,
        );
      }
      const bytes = fromBase64(match[2] ?? '');
      if (bytes.length !== 64) {
        throw new SecretsError('invalid_response', `sign ${key}: signature is not 64 bytes`);
      }
      return bytes;
    },
  };
}
