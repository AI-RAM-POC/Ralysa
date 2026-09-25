// Typed errors. Messages name the path, key or status only: never a token, secret value, response
// body or key material, so they are safe to log (AC-14, SEC-F002-21).

export type SecretsErrorCode =
  | 'config'
  | 'unavailable'
  | 'auth_failed'
  | 'access_denied'
  | 'not_found'
  | 'invalid_response'
  | 'custody_violation'
  | 'unsupported_key';

export class SecretsError extends Error {
  readonly code: SecretsErrorCode;
  readonly status: number | undefined;
  constructor(code: SecretsErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'SecretsError';
    this.code = code;
    this.status = status;
  }
}

/** SEC-F002-11: a Transit key is exportable or allows a plaintext backup. Stop signing. */
export class CustodyViolationError extends SecretsError {
  readonly key: string;
  readonly exportable: boolean;
  readonly allowPlaintextBackup: boolean;
  constructor(key: string, flags: { exportable: boolean; allowPlaintextBackup: boolean }) {
    super(
      'custody_violation',
      `transit key ${key} violates custody: exportable=${String(flags.exportable)} allow_plaintext_backup=${String(flags.allowPlaintextBackup)}`,
    );
    this.name = 'CustodyViolationError';
    this.key = key;
    this.exportable = flags.exportable;
    this.allowPlaintextBackup = flags.allowPlaintextBackup;
  }
}
