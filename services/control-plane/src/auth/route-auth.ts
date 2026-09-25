// Bearer authentication for the control plane's own routes (§6.1): user tokens for /v1/me,
// service tokens for /v1/internal/*. A rejection answers 401 with WWW-Authenticate and is
// recorded through the auth.token_rejected aggregator with the org from config (OI-4).
import type { FastifyRequest } from 'fastify';
import { HttpProblem } from '../http/errors.js';
import type { RtsDeps } from './deps.js';
import {
  type ServicePrincipalClaims,
  TokenRejectedError,
  type UserPrincipalClaims,
} from './verify-local.js';

export async function authenticate(
  deps: RtsDeps,
  request: FastifyRequest,
  kind: 'user',
): Promise<UserPrincipalClaims>;
export async function authenticate(
  deps: RtsDeps,
  request: FastifyRequest,
  kind: 'service',
): Promise<ServicePrincipalClaims>;
export async function authenticate(
  deps: RtsDeps,
  request: FastifyRequest,
  kind: 'user' | 'service',
): Promise<UserPrincipalClaims | ServicePrincipalClaims> {
  try {
    return kind === 'user'
      ? await deps.verifier.user(request.headers.authorization)
      : await deps.verifier.service(request.headers.authorization);
  } catch (error) {
    if (!(error instanceof TokenRejectedError)) throw error;
    deps.rejections.record({
      orgId: deps.config.org.id,
      clientIp: request.ip,
      reason: error.reason,
      audience: 'control-plane',
      traceId: request.traceId,
    });
    throw new HttpProblem('unauthorized', undefined, {
      headers: { 'www-authenticate': `Bearer error="invalid_token"` },
    });
  }
}
