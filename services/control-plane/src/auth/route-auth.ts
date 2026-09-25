// Bearer authentication for the control plane's own routes (§6.1): user tokens for /v1/me and the
// user audit routes, service tokens for /v1/internal/* and POST /v1/audit/events. A rejection
// answers 401 with WWW-Authenticate and is recorded through the auth.token_rejected aggregator
// with the org from config (OI-4). The verifier is @ralysa/auth's (T11-11); when the key set or
// the revocation state can't be read the answer is 503, not a token rejection, and one warn line
// (`verifier_unavailable`) carries a scrubbed summary of the underlying fault, never the token.
import {
  type VerifiedPrincipal,
  type VerifiedService,
  VerifierUnavailableError,
} from '@ralysa/auth';
import type { TokenRejectReason } from '@ralysa/protocol/auth';
import type { FastifyRequest } from 'fastify';
import { HttpProblem } from '../http/errors.js';
import { errorSummary } from '../http/logging.js';
import type { RtsDeps } from './deps.js';

type AuthDeps = Pick<RtsDeps, 'verifier' | 'rejections' | 'config'>;

export interface AuthenticateOptions {
  /**
   * Rejection reasons answered 403 instead of 401: an authentic token of the wrong kind or of an
   * unregistered service on POST /v1/audit/events (§3.4.4). Still recorded as auth.token_rejected.
   */
  forbidden?: readonly TokenRejectReason[];
}

export async function authenticate(
  deps: AuthDeps,
  request: FastifyRequest,
  kind: 'user',
  options?: AuthenticateOptions,
): Promise<VerifiedPrincipal>;
export async function authenticate(
  deps: AuthDeps,
  request: FastifyRequest,
  kind: 'service',
  options?: AuthenticateOptions,
): Promise<VerifiedService>;
export async function authenticate(
  deps: AuthDeps,
  request: FastifyRequest,
  kind: 'user' | 'service',
  options: AuthenticateOptions = {},
): Promise<VerifiedPrincipal | VerifiedService> {
  const reject = (reason: TokenRejectReason): never => {
    deps.rejections.record({
      orgId: deps.config.org.id,
      clientIp: request.ip,
      reason,
      audience: 'control-plane',
      traceId: request.traceId,
    });
    if (options.forbidden?.includes(reason) === true) throw new HttpProblem('forbidden');
    throw new HttpProblem('unauthorized', undefined, {
      headers: { 'www-authenticate': `Bearer error="invalid_token"` },
    });
  };
  const header = request.headers.authorization;
  // An Authorization header with the Bearer scheme (any case, RFC 7235); a bare token is refused.
  if (header === undefined || !/^bearer /i.test(header)) return reject('malformed');
  try {
    if (kind === 'user') {
      const result = await deps.verifier.user.verify(header);
      return result.ok ? result.principal : reject(result.reason);
    }
    const result = await deps.verifier.service.verify(header);
    return result.ok ? result.service : reject(result.reason);
  } catch (error) {
    if (error instanceof VerifierUnavailableError) {
      // Logged under `error`, never `err` (review of #26); the summary is type, scrubbed message
      // and code of the cause (a database or fetch fault), so an outage is diagnosable without a
      // token in the log (R32 follow-up).
      request.log.warn(
        { error: errorSummary(error.cause ?? error), token_kind: kind },
        'verifier_unavailable',
      );
      throw new HttpProblem('temporarily_unavailable');
    }
    throw error;
  }
}
