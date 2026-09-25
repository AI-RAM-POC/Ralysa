// Flow A, first leg (F-002 design §5.1; RFC 8628): the IdP's own device authorization flow. The
// user signs in with MFA and Conditional Access on the IdP's pages; the client polls the IdP's
// token endpoint and gets an IdP access token for the RTS API (then `exchangeIdpToken`).
//
// AC-4: every IdP-side failure (declined, expired, blocked, bad code, anything else the IdP
// refuses with) is reported through `reportSignInFailure()` BEFORE the typed error is thrown, so
// an honest client's attempts are all audited. A user cancel (the caller's AbortSignal) is not an
// IdP failure and is not reported.
//
// The IdP's answers are external input: every body is validated, and the vendor error codes
// (Entra AADSTS…) are mapped by the caller's `classifyIdpError` (the CLI owns that table [AR-18]);
// without it, only the RFC 8628 codes are known and everything else is `other`.
import type { AuthConfig, SignInFailureReport } from '@ralysa/protocol/control-plane';
import { z } from 'zod';
import { NetworkError, request } from '../http.js';
import { type AbortSignalLike, randomUuid, sleep } from '../platform.js';
import type { ClientOptions } from './config.js';
import {
  AccessDeniedError,
  type AuthError,
  AuthProtocolError,
  DeviceCodeBlockedError,
  DeviceCodeExpiredError,
  IdpOAuthError,
  TemporarilyUnavailableError,
} from './errors.js';
import { reportSignInFailure } from './exchange.js';

export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

type FailureKind = SignInFailureReport['error'];

/** What a vendor error means, IdP-neutrally. Return undefined to use the RFC 8628 defaults. */
export type IdpErrorClassifier = (
  error: IdpOAuthError,
) => { error: FailureKind; idpErrorCode?: string } | undefined;

const httpUrl = z
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//.test(u), 'http(s) only');

/** RFC 8628 §3.2 (vendor members such as Entra's `message` are ignored). */
const DeviceAuthorizationResponse = z.looseObject({
  device_code: z.string().min(1).max(4096),
  user_code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/, 'printable ASCII'),
  verification_uri: httpUrl,
  expires_in: z.int().min(1).max(3600),
  interval: z.int().min(1).max(60).optional(),
});

const IdpTokenResponse = z.looseObject({
  access_token: z.string().min(1).max(16_384),
  token_type: z.string().max(32).optional(),
});

export interface IdpDeviceSignIn {
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
  /** Polls until the user finishes at the IdP. Throws typed errors (after reporting them). */
  poll(signal?: AbortSignalLike): Promise<{ idpAccessToken: string }>;
}

export interface IdpDeviceOptions extends ClientOptions {
  classifyIdpError?: IdpErrorClassifier;
  /** Sent with failure reports (untrusted display text; RTS strips control characters). */
  deviceLabel?: string;
  now?: () => number;
}

const DEFAULTS: Record<string, FailureKind> = {
  authorization_declined: 'authorization_declined',
  access_denied: 'access_denied',
  expired_token: 'expired_token',
  bad_verification_code: 'bad_verification_code',
};

function classify(
  body: IdpOAuthError,
  custom: IdpErrorClassifier | undefined,
): { error: FailureKind; idpErrorCode?: string } {
  return custom?.(body) ?? { error: DEFAULTS[body.error] ?? 'other' };
}

function typedError(kind: FailureKind, message: string): AuthError {
  switch (kind) {
    case 'expired_token':
    case 'bad_verification_code':
      return new DeviceCodeExpiredError(message, 'auth.failed.expired', kind);
    case 'conditional_access_blocked':
      return new DeviceCodeBlockedError(message, 'auth.failed.idp_error', kind);
    default:
      return new AccessDeniedError(message, 'auth.failed.idp_error', kind);
  }
}

export async function startIdpDeviceSignIn(
  cfg: AuthConfig,
  options: IdpDeviceOptions = {},
): Promise<IdpDeviceSignIn> {
  if (!cfg.flows.idp_device) {
    throw new AccessDeniedError(
      'device code sign-in is disabled',
      'auth.denied.device_code_disabled',
    );
  }
  const now = options.now ?? (() => Date.now());
  const attemptId = randomUuid();
  const fail = async (
    kind: FailureKind,
    idpErrorCode: string | undefined,
    error: AuthError,
  ): Promise<never> => {
    const report: SignInFailureReport = { attempt_id: attemptId, flow: 'idp_device', error: kind };
    if (idpErrorCode !== undefined) report.idp_error_code = idpErrorCode.slice(0, 64);
    if (options.deviceLabel !== undefined) report.device_label = options.deviceLabel.slice(0, 64);
    await reportSignInFailure(cfg, report, options);
    throw error;
  };
  const idpFailure = async (body: unknown, status: number): Promise<never> => {
    const parsed = IdpOAuthError.safeParse(body);
    const { error: kind, idpErrorCode } = parsed.success
      ? classify(parsed.data, options.classifyIdpError)
      : { error: 'other' as const, idpErrorCode: `http_${String(status)}` };
    return fail(kind, idpErrorCode, typedError(kind, `IdP refused the device sign-in (${kind})`));
  };

  let started;
  try {
    started = await request(options, 'POST', cfg.idp.device_authorization_endpoint, {
      form: { client_id: cfg.idp.cli_client_id, scope: cfg.idp.scope },
      what: 'IdP device authorization',
    });
  } catch (error) {
    if (error instanceof NetworkError) {
      throw new TemporarilyUnavailableError(error.message, 'auth.error.idp_unavailable');
    }
    throw error;
  }
  if (started.status >= 500 || started.status === 429) {
    throw new TemporarilyUnavailableError(
      `IdP device authorization answered ${String(started.status)}`,
      'auth.error.idp_unavailable',
    );
  }
  if (started.status !== 200) return idpFailure(started.body, started.status);
  const device = DeviceAuthorizationResponse.safeParse(started.body);
  if (!device.success) {
    return fail(
      'other',
      'invalid_response',
      new AuthProtocolError(
        'IdP device authorization response is unusable',
        'auth.failed.idp_error',
      ),
    );
  }
  const { device_code: deviceCode, expires_in: expiresIn } = device.data;
  const startedAt = now();
  const deadline = startedAt + expiresIn * 1000;
  let intervalMs = (device.data.interval ?? 5) * 1000;
  let polling = false;

  return {
    userCode: device.data.user_code,
    verificationUri: device.data.verification_uri,
    intervalSeconds: intervalMs / 1000,
    expiresInSeconds: expiresIn,
    async poll(signal) {
      if (polling) throw new Error('poll() is already running for this sign-in');
      polling = true;
      let lastTransient = false;
      for (;;) {
        await sleep(intervalMs, signal);
        if (now() >= deadline) {
          return lastTransient
            ? fail(
                'other',
                'idp_unreachable',
                new TemporarilyUnavailableError(
                  'IdP unreachable until the device code expired',
                  'auth.error.idp_unavailable',
                ),
              )
            : fail(
                'expired_token',
                undefined,
                new DeviceCodeExpiredError('the device code expired', 'auth.failed.expired'),
              );
        }
        let reply;
        try {
          reply = await request(options, 'POST', cfg.idp.token_endpoint, {
            form: {
              grant_type: DEVICE_CODE_GRANT,
              client_id: cfg.idp.cli_client_id,
              device_code: deviceCode,
            },
            signal,
            what: 'IdP device token',
          });
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error;
          // RFC 8628 §3.5: back off on connection trouble, keep polling until the code expires.
          lastTransient = true;
          intervalMs = Math.min(intervalMs * 2, 60_000);
          continue;
        }
        if (reply.status === 200) {
          const token = IdpTokenResponse.safeParse(reply.body);
          if (!token.success) {
            return fail(
              'other',
              'invalid_response',
              new AuthProtocolError('IdP token response is unusable', 'auth.failed.idp_error'),
            );
          }
          return { idpAccessToken: token.data.access_token };
        }
        if (reply.status >= 500 || reply.status === 429) {
          lastTransient = true;
          intervalMs = Math.min(intervalMs * 2, 60_000);
          continue;
        }
        lastTransient = false;
        const body = IdpOAuthError.safeParse(reply.body);
        if (body.success && body.data.error === 'authorization_pending') continue;
        if (body.success && body.data.error === 'slow_down') {
          intervalMs += 5_000;
          continue;
        }
        return idpFailure(reply.body, reply.status);
      }
    },
  };
}
