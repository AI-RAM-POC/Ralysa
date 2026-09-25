// Opaque Ralysa tokens (F-002 design §3.2.1): `rly_rt_` refresh tokens and `rly_ac_` authorization
// codes, 32 random bytes as 43 base64url characters. Only SHA-256 hashes are stored; the prefixes
// let gitleaks (T14) and the log scrubber recognise them.
import { createHash, randomBytes } from 'node:crypto';
import { AUTHORIZATION_CODE_PREFIX, REFRESH_TOKEN_PREFIX } from '@ralysa/protocol/auth';

const random43 = (): string => randomBytes(32).toString('base64url');

export const newRefreshToken = (): string => `${REFRESH_TOKEN_PREFIX}${random43()}`;
export const newAuthorizationCode = (): string => `${AUTHORIZATION_CODE_PREFIX}${random43()}`;

/** SHA-256 of a token (what the database stores and looks up). */
export const tokenHash = (token: string): Buffer =>
  createHash('sha256').update(token, 'utf8').digest();
