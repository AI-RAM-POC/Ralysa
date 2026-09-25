// Per-request context (F-002 design §3.1, §4.1, §6.4; SEC-F002-31):
// - request ids are UUIDv7, never taken from the client;
// - the W3C traceparent is continued when valid, else a new trace starts; the response always
//   carries `traceparent` back, and audit events use request.traceId;
// - the client IP is Fastify's request.ip, which honours X-Forwarded-For only from
//   trust_proxy_cidrs (configured on the Fastify instance);
// - the org for unauthenticated routes is config.org.id. It never comes from a header, host,
//   path or body (an X-Org-Id header is ignored; tested).
import {
  formatTraceparent,
  newSpanId,
  newTraceId,
  parseTraceparent,
  uuidv7,
} from '@ralysa/protocol/common';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string;
    spanId: string;
    /** The org this request acts in. Unauthenticated routes: config.org.id. */
    orgId: string;
  }
}

export const genRequestId = (): string => uuidv7();

export function registerRequestContext(app: FastifyInstance, orgId: string): void {
  app.decorateRequest('traceId', '');
  app.decorateRequest('spanId', '');
  app.decorateRequest('orgId', '');
  app.addHook('onRequest', (request, reply, done) => {
    const header = request.headers.traceparent;
    const parent = parseTraceparent(typeof header === 'string' ? header : undefined);
    request.traceId = parent?.traceId ?? newTraceId();
    request.spanId = newSpanId();
    request.orgId = orgId;
    reply.header(
      'traceparent',
      formatTraceparent({
        traceId: request.traceId,
        spanId: request.spanId,
        sampled: parent?.sampled ?? false,
      }),
    );
    done();
  });
}
