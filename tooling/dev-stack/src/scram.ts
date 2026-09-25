// SCRAM-SHA-256 password verifiers (RFC 5802, RFC 7677), in the form Postgres stores in
// pg_authid.rolpassword. The bootstrap sends verifiers, never plaintext role passwords, so even a
// logged statement or a psql history line would not reveal a password (SEC-F002-29).
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

export const SCRAM_ITERATIONS = 4096;

export interface ScramKeys {
  salt: Buffer;
  iterations: number;
  clientKey: Buffer;
  storedKey: Buffer;
  serverKey: Buffer;
}

/** The password must already be SASLprep-normalised; generated passwords are ASCII alphanumeric. */
export function scramKeys(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations = SCRAM_ITERATIONS,
): ScramKeys {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return { salt, iterations, clientKey, storedKey, serverKey };
}

/** `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>` (all base64). */
export function scramVerifier(password: string, salt?: Buffer): string {
  const k = scramKeys(password, salt);
  return `SCRAM-SHA-256$${String(k.iterations)}:${k.salt.toString('base64')}$${k.storedKey.toString('base64')}:${k.serverKey.toString('base64')}`;
}
