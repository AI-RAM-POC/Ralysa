// buildApp(): the serve process's Fastify instance without listen, so tests inject their own
// dependencies (F-002 design §2.1). Logging per §6.6, zod validation, problem+json errors,
// traceparent, rate limits on unauthenticated routes, health, discovery.
import { newTraceId } from '@ralysa/protocol/common';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import { registerClientEvents } from './audit/routes/client-events.js';
import { registerAuditQuery } from './audit/routes/query.js';
import { registerServiceEvents } from './audit/routes/service-events.js';
import { type RtsServices, assembleRtsDeps, exchangeEnv } from './auth/deps.js';
import { registerGovernanceFeed } from './auth/governance-feed.js';
import { registerAuthorizeRoutes } from './auth/routes/authorize.js';
import { registerDiscovery } from './auth/routes/discovery.js';
import { registerSignInFailures } from './auth/routes/sign-in-failures.js';
import { registerTokenRoutes } from './auth/routes/token.js';
import type { SigningKeys } from './auth/tokens/signing-keys.js';
import type { ServeConfig } from './config/schema.js';
import { registerDirectoryRoutes } from './directory/routes.js';
import { ROUTES } from './http/contracts.js';
import { handleError, sendProblem } from './http/errors.js';
import { responseSummary } from './http/logging.js';
import { type RateLimiter, createRateLimiter, registerRateLimits } from './http/rate-limits.js';
import { genRequestId, registerRequestContext } from './http/request-context.js';
import { registerZod } from './http/zod-validation.js';
import { type PinoLogger, createPinoLogger } from './observability/pino.js';

export const BODY_LIMIT_BYTES = 256 * 1024;

export interface AppDeps {
  config: ServeConfig;
  keys: SigningKeys;
  /** Sessions, grants, sign-in, the governance feed, directory and audit routes (T08–T12). */
  rts: RtsServices;
  /** Database liveness for /readyz. */
  pingDatabase: () => Promise<boolean>;
  rateLimiter?: RateLimiter;
  /** The process's one pino instance (§6.6 rules); a fresh one when absent. */
  logger?: PinoLogger;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // Typed as Fastify's base logger so the instance keeps the default FastifyInstance type that
    // the route registrars take (without it tsc infers a pino-specific instance type).
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- see above
    loggerInstance: (deps.logger ?? createPinoLogger()) as FastifyBaseLogger,
    // Fastify's own request lines log the raw URL; ours (onResponse) log the route template only.
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: genRequestId,
    requestIdHeader: false,
    trustProxy: deps.config.trust_proxy_cidrs.length === 0 ? false : deps.config.trust_proxy_cidrs,
    bodyLimit: BODY_LIMIT_BYTES,
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: false },
    // A URL the router can't decode (e.g. /%E0%A4%A) never reaches hooks or handlers: answer
    // problem+json and write the one summary line here (review of #25).
    frameworkErrors: (error, request, reply) => {
      request.traceId = newTraceId();
      request.log.info(
        {
          method: request.method,
          route: 'bad_url',
          request_id: request.id,
          status: 400,
          code: error.code,
        },
        'request',
      );
      void sendProblem(reply, request, 'invalid_request');
    },
  });
  registerZod(app);
  registerRequestContext(app, deps.config.org.id);
  registerRateLimits(
    app,
    deps.rateLimiter ??
      createRateLimiter({
        perIpPerMinute: deps.config.rate_limits.per_ip_per_minute,
        globalPerMinute: deps.config.rate_limits.global_per_minute,
      }),
  );
  app.addHook('onResponse', (request, reply, done) => {
    request.log.info(responseSummary(request, reply), 'request');
    done();
  });
  app.setErrorHandler((error, request, reply) => handleError(error, request, reply));
  app.setNotFoundHandler((request, reply) => sendProblem(reply, request, 'not_found'));

  app.get(
    ROUTES.healthz.url,
    { schema: { response: { 200: ROUTES.healthz.responses[200].schema } } },
    () => ({
      status: 'ok' as const,
    }),
  );
  app.get(
    ROUTES.readyz.url,
    {
      schema: {
        response: {
          200: ROUTES.readyz.responses[200].schema,
          503: ROUTES.readyz.responses[503].schema,
        },
      },
    },
    async (_request, reply) => {
      const status = deps.keys.status();
      const checks = {
        database: await deps.pingDatabase().catch(() => false),
        signing_key: status.activeVersion !== undefined && status.ready,
        custody: status.custodyViolation === undefined,
      };
      const ready = checks.database && checks.signing_key && checks.custody;
      return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'unready', checks });
    },
  );
  registerDiscovery(app, { config: deps.config, keys: deps.keys });
  const rts = assembleRtsDeps(deps.config, deps.keys, deps.rts);
  registerTokenRoutes(app, rts);
  registerSignInFailures(app, rts, rts.signInFailures);
  registerAuthorizeRoutes(app, rts, exchangeEnv(rts));
  registerGovernanceFeed(app, rts);
  registerDirectoryRoutes(app, rts);
  registerServiceEvents(app, rts);
  registerClientEvents(app, rts);
  registerAuditQuery(app, rts);
  await app.ready();
  return app;
}
