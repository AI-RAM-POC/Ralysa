// Bearer authentication for the control plane's own routes (§6.1): user tokens for /v1/me and the
// user audit routes, service tokens for /v1/internal/* and POST /v1/audit/events. A rejection
// answers 401 with WWW-Authenticate and is recorded through the auth.token_rejected aggregator
// with the org from config (OI-4). The verifier is @ralysa/auth's (T11-11); when the key set
// can't be read the answer is 503, not a token rejection.
import {
  type VerifiedPrincipal,
  type VerifiedService,
  VerifierUnavailableError,
} from '@ralysa/auth';
import type { TokenRejectReason } from '@ralysa/protocol/auth';
import type { FastifyRequest } from 'fastify';
import { HttpProblem } from '../http/errors.js';
import type { RtsDeps } from './deps.js';

type AuthDeps = Pick<RtsDeps, 'verifier' | 'rejections' | 'config'>;

export async function authenticate(
  deps: AuthDeps,
  request: FastifyRequest,
  kind: 'user',
): Promise<VerifiedPrincipal>;
export async function authenticate(
  deps: AuthDeps,
  request: FastifyRequest,
  kind: 'service',
): Promise<VerifiedService>;
export async function authenticate(
  deps: AuthDeps,
  request: FastifyRequest,
  kind: 'user' | 'service',
): Promise<VerifiedPrincipal | VerifiedService> {
  const reject = (reason: TokenRejectReason): never => {
    deps.rejections.record({
      orgId: deps.config.org.id,
      clientIp: request.ip,
      reason,
      audience: 'control-plane',
      traceId: request.traceId,
    });
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
    if (error instanceof VerifierUnavailableError) throw new HttpProblem('temporarily_unavailable');
    throw error;
  }
}
