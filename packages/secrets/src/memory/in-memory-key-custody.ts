// Hermetic KeyCustody double (F-002 design §3.7): WebCrypto ECDSA P-256 keys whose private half
// is created with extractable=false, versioned like Transit. `setFlags` simulates an operator
// flipping `exportable` or `allow_plaintext_backup` so custody-monitor logic can be unit-tested
// (TC-F-002-33's hermetic half); `describe` then refuses exactly as the Transit adapter does.
import { SecretsError } from '../errors.js';
import { type CryptoKeyHandle, subtle } from '../platform.js';
import type { KeyCustody, KeyDescription, PublicJwk } from '../ports.js';
import { checkCustody } from '../openbao/transit.js';

interface Version {
  privateKey: CryptoKeyHandle;
  jwk: PublicJwk;
  createdAt: Date;
}
interface Key {
  versions: Version[];
  minAvailableVersion: number;
  minDecryptionVersion: number;
  exportable: boolean;
  allowPlaintextBackup: boolean;
}

export interface InMemoryKeyCustody extends KeyCustody {
  /** Adds a version (creates the key at version 1 when it doesn't exist). */
  rotate(key: string): Promise<void>;
  setFlags(key: string, flags: { exportable?: boolean; allowPlaintextBackup?: boolean }): void;
  /** Like Transit `min_decryption_version`/trimming: versions below it can't sign or be listed. */
  setMinAvailableVersion(key: string, version: number): void;
  /** Transit `min_decryption_version`: versions below it are still listed but no longer verify. */
  setMinDecryptionVersion(key: string, version: number): void;
}

export function createInMemoryKeyCustody(options: { now?: () => Date } = {}): InMemoryKeyCustody {
  const keys = new Map<string, Key>();
  const now = options.now ?? (() => new Date());

  const existing = (key: string): Key => {
    const entry = keys.get(key);
    if (entry === undefined) throw new SecretsError('not_found', `describe ${key}: not found`, 404);
    return entry;
  };

  return {
    async rotate(key) {
      const pair = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
        'verify',
      ]);
      const exported = await subtle().exportKey('jwk', pair.publicKey);
      const jwk: PublicJwk = {
        kty: 'EC',
        crv: 'P-256',
        x: String(exported.x),
        y: String(exported.y),
      };
      const entry = keys.get(key) ?? {
        versions: [],
        minAvailableVersion: 0,
        minDecryptionVersion: 1,
        exportable: false,
        allowPlaintextBackup: false,
      };
      entry.versions.push({ privateKey: pair.privateKey, jwk, createdAt: now() });
      keys.set(key, entry);
    },

    setFlags(key, flags) {
      const entry = existing(key);
      if (flags.exportable !== undefined) entry.exportable = flags.exportable;
      if (flags.allowPlaintextBackup !== undefined) {
        entry.allowPlaintextBackup = flags.allowPlaintextBackup;
      }
    },

    setMinAvailableVersion(key, version) {
      existing(key).minAvailableVersion = version;
    },

    setMinDecryptionVersion(key, version) {
      existing(key).minDecryptionVersion = version;
    },

    describe(key): Promise<KeyDescription> {
      try {
        const entry = existing(key);
        checkCustody(key, {
          type: 'ecdsa-p256',
          exportable: entry.exportable,
          allowPlaintextBackup: entry.allowPlaintextBackup,
        });
        const from = Math.max(1, entry.minAvailableVersion);
        return Promise.resolve({
          latestVersion: entry.versions.length,
          minAvailableVersion: entry.minAvailableVersion,
          minDecryptionVersion: entry.minDecryptionVersion,
          exportable: false,
          allowPlaintextBackup: false,
          versions: entry.versions
            .map((v, i) => ({ version: i + 1, jwk: { ...v.jwk }, createdAt: v.createdAt }))
            .filter((v) => v.version >= from),
        });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async sign(key, version, signingInput) {
      const entry = existing(key);
      const v = entry.versions[version - 1];
      if (v === undefined || version < Math.max(1, entry.minAvailableVersion)) {
        throw new SecretsError(
          'invalid_response',
          `sign ${key}: version ${String(version)} unavailable`,
          400,
        );
      }
      // Transit signs whatever the policy allows even when flags are flipped; the caller's custody
      // monitor is what stops signing. Mirror that here so the monitor is actually exercised.
      const signature = await subtle().sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        v.privateKey,
        signingInput,
      );
      return new Uint8Array(signature);
    },
  };
}
