// A service's own access token for the control plane (F-002 design §3.2.7, [AR-1]): the
// client_credentials grant with a Transit-signed client assertion, a 5-minute token.
//
// Renewal: the token is renewed once 50 % of its lifetime (plus up to 10 % jitter, so replicas
// don't renew in lockstep) has passed, and the CURRENT token keeps being used until it expires.
// A renewal that fails (OpenBao or RTS down) doesn't disturb callers while the current token is
// valid; it is retried with backoff. Only when the token has expired and no new one can be had
// does `getToken()` throw, and then every PEP that needs the control plane (the feed, principals,
// audit writes) fails closed. That is why OpenBao sits in the control-plane HA tier.
import { JWT_BEARER_ASSERTION_TYPE, TokenResponse } from '@ralysa/protocol/auth';
import { type HttpOptions, NetworkError, request } from '../http.js';
import { type AssertionSigner, createClientAssertion } from './client-assertion.js';

export interface ServiceTokenSource {
  /** A valid service token (`aud=control-plane`, `token_use=service`). */
  getToken(): Promise<string>;
}

export class ServiceTokenUnavailableError extends Error {
  constructor(detail: string) {
    super(`no valid service token: ${detail}`);
    this.name = 'ServiceTokenUnavailableError';
  }
}

export interface ServiceTokenSourceOptions extends HttpOptions {
  /** Where to POST (may be an internal address). */
  tokenEndpoint: string;
  /** The assertion's `aud`: RTS's token endpoint as RTS names it. Default `tokenEndpoint`. */
  assertionAudience?: string;
  /** `svc:<name>` */
  clientId: string;
  /** Transit-backed in services (`createTransitAssertionSigner`). */
  signer: AssertionSigner;
  now?: () => number;
  /** In [0, 1); default Math.random. */
  random?: () => number;
}

/** A token is not handed out in its last 5 s, so it can't expire on the way (README). */
const EXPIRY_MARGIN_MS = 5_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** The source plus a hook that resolves when no renewal is in flight (tests, graceful shutdown). */
export interface ManagedServiceTokenSource extends ServiceTokenSource {
  settled(): Promise<void>;
}

export function createServiceTokenSource(
  opts: ServiceTokenSourceOptions,
): ManagedServiceTokenSource {
  if (!/^svc:[a-z][a-z0-9-]{1,40}$/.test(opts.clientId)) {
    throw new Error('clientId must be svc:<name>');
  }
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  let current: { token: string; expiresAt: number; renewAt: number } | undefined;
  let renewing: Promise<void> | undefined;
  let lastError: unknown;
  let retryAt = 0;
  let retryDelay = RETRY_MIN_MS;

  const fetchToken = async (): Promise<void> => {
    const sentAt = now();
    const assertion = await createClientAssertion({
      clientId: opts.clientId,
      audience: opts.assertionAudience ?? opts.tokenEndpoint,
      signer: opts.signer,
      nowSeconds: Math.floor(sentAt / 1000),
    });
    const reply = await request(opts, 'POST', opts.tokenEndpoint, {
      form: {
        grant_type: 'client_credentials',
        client_assertion_type: JWT_BEARER_ASSERTION_TYPE,
        client_assertion: assertion,
        client_id: opts.clientId,
      },
      what: 'RTS client_credentials',
    });
    const parsed = reply.status === 200 ? TokenResponse.safeParse(reply.body) : undefined;
    if (parsed?.success !== true || parsed.data.expires_in <= 0) {
      const error =
        typeof reply.body === 'object' && reply.body !== null && 'error' in reply.body
          ? String(reply.body.error).slice(0, 64)
          : 'unusable answer';
      throw new ServiceTokenUnavailableError(`RTS answered ${String(reply.status)} (${error})`);
    }
    const lifetimeMs = parsed.data.expires_in * 1000;
    current = {
      token: parsed.data.access_token,
      expiresAt: sentAt + lifetimeMs,
      renewAt: sentAt + lifetimeMs * (0.5 + 0.1 * random()),
    };
  };

  const renew = (): Promise<void> => {
    renewing ??= fetchToken()
      .then(() => {
        lastError = undefined;
        retryDelay = RETRY_MIN_MS;
      })
      .catch((error: unknown) => {
        lastError = error;
        retryAt = now() + retryDelay;
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      })
      .finally(() => {
        renewing = undefined;
      });
    return renewing;
  };

  const valid = () => current !== undefined && now() < current.expiresAt - EXPIRY_MARGIN_MS;

  const unavailable = () =>
    new ServiceTokenUnavailableError(
      lastError instanceof NetworkError || lastError instanceof ServiceTokenUnavailableError
        ? lastError.message
        : 'signing or transport failed',
    );

  return {
    async getToken() {
      if (valid()) {
        // Renew in the background from 50 % (+ jitter); keep serving the current token meanwhile.
        if (current !== undefined && now() >= current.renewAt && now() >= retryAt) void renew();
        return (current as { token: string }).token;
      }
      // Expired and the last attempt failed: honour the backoff instead of calling OpenBao and RTS
      // on every request during an outage [AR-1]. A renewal already in flight is joined.
      if (renewing === undefined && now() < retryAt) throw unavailable();
      await renew();
      if (valid()) return (current as { token: string }).token;
      throw unavailable();
    },
    settled: () => renewing ?? Promise.resolve(),
  };
}
