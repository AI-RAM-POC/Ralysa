// buildApp(): the serve process's Fastify instance without listen, so tests inject their own
// dependencies (F-002 design §2.1). Logging per §6.6, zod validation, problem+json errors,
// traceparent, rate limits on unauthenticated routes, health, discovery.
import Fastify, { type FastifyInstance } from 'fastify';
import { registerDiscovery } from './auth/routes/discovery.js';
import type { SigningKeys } from './auth/tokens/signing-keys.js';
import type { ServeConfig } from './config/schema.js';
import { ROUTES } from './http/contracts.js';
import { handleError, sendProblem } from './http/errors.js';
import { loggerOptions, responseSummary } from './http/logging.js';
import { type RateLimiter, createRateLimiter, registerRateLimits } from './http/rate-limits.js';
import { genRequestId, registerRequestContext } from './http/request-context.js';
import { registerZod } from './http/zod-validation.js';

export const BODY_LIMIT_BYTES = 256 * 1024;

export interface AppDeps {
  config: ServeConfig;
  keys: SigningKeys;
  /** Database liveness for /readyz. */
  pingDatabase: () => Promise<boolean>;
  rateLimiter?: RateLimiter;
  logLevel?: string;
  /** Tests capture log lines here (pino destination). */
  logStream?: { write(line: string): void };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const logger = loggerOptions(deps.logLevel ?? 'info');
  const app = Fastify({
    logger: deps.logStream === undefined ? logger : { ...logger, stream: deps.logStream },
    disableRequestLogging: true,
    genReqId: genRequestId,
    requestIdHeader: false,
    trustProxy: deps.config.trust_proxy_cidrs.length === 0 ? false : deps.config.trust_proxy_cidrs,
    bodyLimit: BODY_LIMIT_BYTES,
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: false },
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
  await app.ready();
  return app;
}
