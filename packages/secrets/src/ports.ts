// The secrets ports (F-002 design §3.7). The control plane (and model-gateway in F-004) depend on
// these only; OpenBao/Vault, a cloud KMS or the in-memory doubles sit behind them.

/** A KV v2 secret: the value and its metadata version. */
export interface SecretValue {
  value: string;
  version: number;
}

export interface SecretStore {
  /** `path` includes the mount, e.g. `kv/ralysa/control-plane/idp-client-secret`. */
  get(path: string): Promise<SecretValue>;
  /**
   * Polls every `pollMs` and calls `onChange` when the version changes (not for the version seen
   * at start). `onError` receives poll failures; polling continues. Returns a stop function.
   */
  watch(
    path: string,
    onChange: (value: SecretValue) => void,
    pollMs: number,
    onError?: (error: unknown) => void,
  ): () => void;
}

/** A P-256 public key as a JWK (public members only). */
export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface PublicKeyVersion {
  version: number;
  jwk: PublicJwk;
  createdAt: Date;
}

export interface KeyDescription {
  latestVersion: number;
  minAvailableVersion: number;
  /**
   * Transit `min_decryption_version`: versions below it no longer verify at Transit. Verifiers
   * outside Transit treat them as retired too (F-002 review of #26).
   */
  minDecryptionVersion: number;
  exportable: false;
  allowPlaintextBackup: false;
  /** Versions from `minAvailableVersion` (or 1) to `latestVersion`, ascending. */
  versions: PublicKeyVersion[];
}

export interface KeyCustody {
  /**
   * Rejects with CustodyViolationError when `exportable` or `allow_plaintext_backup` is true
   * [SEC-F002-11], and with `unsupported_key` for anything but ecdsa-p256.
   */
  describe(key: string): Promise<KeyDescription>;
  /**
   * ES256 over `signingInput` (the key service hashes it with SHA-256) with exactly `version`.
   * Returns the raw JWS signature bytes (r‖s, 64 bytes).
   */
  sign(key: string, version: number, signingInput: Uint8Array): Promise<Uint8Array>;
}

/** Where the caller runs; comes only from the control-plane config's `env` [SEC-F002-12]. */
export type RuntimeEnv = 'dev' | 'test' | 'production';

export type VaultAuth =
  /** The caller reads the ServiceAccount token file. */
  | { method: 'kubernetes'; role: string; jwt: () => Promise<string>; mount?: string }
  /** Refused in production unless `allowAppRole` (SEC-F002-22 conditions apply). */
  | { method: 'approle'; roleId: string; secretId: () => Promise<string>; mount?: string }
  /** Refused unless env is dev or test. */
  | { method: 'token'; token: string };
