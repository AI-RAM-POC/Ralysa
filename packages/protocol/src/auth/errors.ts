// Sign-in and refresh reason codes and their i18n keys (F-002 design §3.5 catalogue, §3.9).
// A code doubles as `ralysa_error.code`; the key is `auth.denied.<code>`, `auth.failed.<code>`
// or `auth.error.<code>` by the outcome it was recorded with [AR-3]. F-005 owns the en/ar
// catalog strings; `check-i18n` can require both locales from AUTH_I18N_KEYS once it exists.
import { z } from 'zod';

type ReasonOutcome = 'failure' | 'denied' | 'error';

/** `auth.sign_in` reasons with the outcome each is recorded with. */
export const SIGN_IN_REASON_OUTCOMES = {
  idp_error: 'failure',
  invalid_idp_token: 'failure',
  untrusted_issuer: 'failure',
  expired: 'failure',
  replay: 'failure',
  mfa_claim_missing: 'failure',
  browser_binding_failed: 'failure',
  code_not_redeemed: 'failure',
  not_in_access_group: 'denied',
  user_disabled: 'denied',
  device_code_disabled: 'denied',
  admin_requires_strong_flow: 'denied',
  loopback_ip_mismatch: 'denied',
  idp_unavailable: 'error',
  group_overage_unresolved: 'error',
  /**
   * An internal fault ended the attempt (token signing or the database). Added by F-002-T10
   * (T10-4): every attempt is audited exactly once (AC-4), and none of the reasons above fits.
   */
  internal_error: 'error',
} as const satisfies Record<string, ReasonOutcome>;

/** `auth.refresh` reasons (§3.5, §5.3) with their outcome. */
export const REFRESH_REASON_OUTCOMES = {
  revoked: 'denied',
  expired: 'denied',
  user_disabled: 'denied',
  not_in_access_group: 'denied',
  reuse_detected: 'denied',
  idp_session_revoked: 'denied',
  idp_unavailable: 'error',
} as const satisfies Record<string, ReasonOutcome>;

type SignInReasonName = keyof typeof SIGN_IN_REASON_OUTCOMES;
type RefreshReasonName = keyof typeof REFRESH_REASON_OUTCOMES;

const keysOf = <T extends object>(record: T) => Object.keys(record) as (keyof T & string)[];

export const SignInReason = z.enum(
  keysOf(SIGN_IN_REASON_OUTCOMES) as [SignInReasonName, ...SignInReasonName[]],
);
export type SignInReason = z.infer<typeof SignInReason>;

export const RefreshReason = z.enum(
  keysOf(REFRESH_REASON_OUTCOMES) as [RefreshReasonName, ...RefreshReasonName[]],
);
export type RefreshReason = z.infer<typeof RefreshReason>;

/** What `ralysa_error.code` may carry: every sign-in and refresh reason. */
export const RalysaErrorCode = z.enum([
  ...new Set<SignInReasonName | RefreshReasonName>([
    ...SignInReason.options,
    ...RefreshReason.options,
  ]),
] as [SignInReasonName | RefreshReasonName, ...(SignInReasonName | RefreshReasonName)[]]);
export type RalysaErrorCode = z.infer<typeof RalysaErrorCode>;

const CATEGORY: Record<ReasonOutcome, string> = {
  failure: 'failed',
  denied: 'denied',
  error: 'error',
};

/** `auth.<denied|failed|error>.<code>`. */
export function authI18nKey(outcome: ReasonOutcome, code: string): string {
  return `auth.${CATEGORY[outcome]}.${code}`;
}

export const signInI18nKey = (reason: SignInReason): string =>
  authI18nKey(SIGN_IN_REASON_OUTCOMES[reason], reason);
export const refreshI18nKey = (reason: RefreshReason): string =>
  authI18nKey(REFRESH_REASON_OUTCOMES[reason], reason);

/** The one server-rendered string: RTS's plain-text en/ar error at `/oauth2/authorize` (D-20). */
export const INVALID_AUTHORIZE_REQUEST_KEY = 'auth.error.invalid_authorize_request';

/** Every auth i18n key a client may be handed, sorted and unique. */
export const AUTH_I18N_KEYS: readonly string[] = [
  ...new Set([
    ...SignInReason.options.map(signInI18nKey),
    ...RefreshReason.options.map(refreshI18nKey),
    INVALID_AUTHORIZE_REQUEST_KEY,
  ]),
].sort();
