// POST /oauth2/token and POST /oauth2/revoke (F-002 design §3.1, §3.3, §5.3, §5.4; AC-3, AC-8).
// - No client secret, ever: a `client_secret` parameter or Basic authorization is invalid_client.
// - Grants: refresh_token and client_credentials here; authorization_code and token exchange are
//   dispatched by F-002-T10 (until then unsupported_grant_type). Anything else, `password`
//   included, is unsupported_grant_type.
// - Responses carry Cache-Control: no-store (RFC 6749 §5.1).
// - Revocation always answers 200 (RFC 7009); a known refresh token revokes its whole session
//   and writes auth.sign_out.
import { CLI_CLIENT_ID, REFRESH_TOKEN_PATTERN, RevokeRequest } from '@ralysa/protocol/auth';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withOrg } from '../../db/kysely.js';
import { OAuthProblem } from '../../http/errors.js';
import { ROUTES } from '../../http/contracts.js';
import { registerFormParser } from '../../http/form.js';
import { authEvent } from '../audit-events.js';
import type { RtsDeps } from '../deps.js';
import { clientCredentialsGrant, createServiceKeyCache } from '../grants/client-credentials.js';
import { type GrantContext, refreshGrant } from '../grants/refresh-token.js';
import { findRefreshToken, revokeSession } from '../sessions.js';

const context = (request: FastifyRequest): GrantContext => ({
  traceId: request.traceId,
  clientIp: request.ip,
});

function formBody(request: FastifyRequest): Record<string, string> {
  if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
    throw new OAuthProblem({
      error: 'invalid_request',
      error_description: 'form-encoded body required',
    });
  }
  if (request.headers.authorization !== undefined || 'client_secret' in (request.body as object)) {
    throw new OAuthProblem(
      { error: 'invalid_client', error_description: 'client secrets are not accepted' },
      401,
    );
  }
  return request.body as Record<string, string>;
}

export function registerTokenRoutes(app: FastifyInstance, deps: RtsDeps): void {
  registerFormParser(app);
  const keyFor = createServiceKeyCache(deps);

  app.post(ROUTES.token.url, async (request, reply) => {
    reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
    const body = formBody(request);
    const grant = body.grant_type;
    if (grant === undefined)
      throw new OAuthProblem({ error: 'invalid_request', error_description: 'grant_type' });
    if (grant === 'refresh_token') return refreshGrant(deps, body, context(request));
    if (grant === 'client_credentials')
      return clientCredentialsGrant(deps, body, context(request), keyFor);
    // authorization_code and token exchange (GRANT_TYPES) arrive with F-002-T10; until then they
    // answer like every other grant RTS doesn't serve, `password` included.
    throw new OAuthProblem({ error: 'unsupported_grant_type' });
  });

  app.post(ROUTES.revoke.url, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const body = formBody(request);
    // RFC 7009 §2.2.1: an unknown client is invalid_client (401), before anything else.
    if (body.client_id !== CLI_CLIENT_ID) throw new OAuthProblem({ error: 'invalid_client' }, 401);
    const parsed = RevokeRequest.safeParse(body);
    if (!parsed.success) throw new OAuthProblem({ error: 'invalid_request' });
    const token = parsed.data.token;
    if (REFRESH_TOKEN_PATTERN.test(token)) {
      const orgId = deps.config.org.id;
      const signedOut = await withOrg(deps.db, orgId, async (trx) => {
        const view = await findRefreshToken(trx, token);
        if (view === undefined) return undefined;
        const wasActive = await revokeSession(trx, view.sessionId, 'sign_out');
        return wasActive ? view : undefined;
      });
      if (signedOut !== undefined) {
        await deps.writer.writeOrSpool(orgId, [
          authEvent({
            action: 'auth.sign_out',
            outcome: 'success',
            traceId: request.traceId,
            user: { id: signedOut.userId, idpSubject: signedOut.idpSubject },
            sessionId: signedOut.sessionId,
            details: { sid: signedOut.sessionId, surface: signedOut.surface },
          }),
        ]);
      }
    }
    return reply.status(200).send({});
  });
}
