// GET /oauth2/authorize and GET /oauth2/idp/callback: flow B's browser legs (F-002 design §3.3,
// §5.2, §7; D-20; SEC-F002-04). The logic is in flow-b.ts; this file is HTTP only.
// - Redirects are 302 with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, so a
//   code or state never reaches another site in a Referer header.
// - The browser-binding cookie is `__Host-rts_tx` (Secure, HttpOnly, SameSite=Lax, Path=/, 10
//   min). Outside production on plain-http loopback it is `rts_tx` without Secure; never in
//   production. The callback clears it.
// - The one server-rendered response is a plain-text UTF-8 body with the English and Arabic
//   sentences for `auth.error.invalid_authorize_request` and `Content-Language: en, ar`. There is
//   no HTML (D-20), so nothing here needs layout, RTL or keyboard handling.
// Request logging never includes the URL or query (T07, §6.6), so `code` and `state` stay out.
import { INVALID_AUTHORIZE_REQUEST_KEY } from '@ralysa/protocol/auth';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ROUTES } from '../../http/contracts.js';
import ar from '../../i18n/ar.json' with { type: 'json' };
import en from '../../i18n/en.json' with { type: 'json' };
import type { RtsDeps } from '../deps.js';
import {
  AUTH_REQUEST_TTL_S,
  type FlowBEnv,
  bindingCookie,
  completeCallback,
  startAuthorize,
} from '../flow-b.js';

const message = (catalog: typeof en, key: string): string => {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      catalog,
    );
  return typeof value === 'string' ? value : key;
};

/** The en + ar sentences for the invalid-request page (text, no markup). */
export const INVALID_AUTHORIZE_TEXT = `${message(en, INVALID_AUTHORIZE_REQUEST_KEY)}\n${message(ar, INVALID_AUTHORIZE_REQUEST_KEY)}\n`;

function plainError(reply: FastifyReply): FastifyReply {
  return reply
    .status(400)
    .header('cache-control', 'no-store')
    .header('content-language', 'en, ar')
    .type('text/plain; charset=utf-8')
    .send(INVALID_AUTHORIZE_TEXT);
}

function redirect(reply: FastifyReply, location: string): FastifyReply {
  return reply
    .status(302)
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('location', location)
    .send();
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const rawQuery = (request: FastifyRequest): string => {
  const at = request.url.indexOf('?');
  return at < 0 ? '' : request.url.slice(at);
};

export function registerAuthorizeRoutes(app: FastifyInstance, deps: RtsDeps, env: FlowBEnv): void {
  const cookie = bindingCookie(deps.config);
  const attributes = `Path=/; HttpOnly; SameSite=Lax${cookie.secure ? '; Secure' : ''}`;

  app.get(ROUTES.authorize.url, async (request, reply) => {
    const outcome = await startAuthorize(env, request.query as Record<string, unknown>, {
      clientIp: request.ip,
    });
    if (outcome.kind === 'invalid') return plainError(reply);
    if (outcome.binding !== undefined) {
      reply.header(
        'set-cookie',
        `${cookie.name}=${outcome.binding}; Max-Age=${String(AUTH_REQUEST_TTL_S)}; ${attributes}`,
      );
    }
    return redirect(reply, outcome.location);
  });

  app.get(ROUTES.idpCallback.url, async (request, reply) => {
    const outcome = await completeCallback(env, request.query as Record<string, unknown>, {
      clientIp: request.ip,
      traceId: request.traceId,
      userAgent: request.headers['user-agent'],
      binding: readCookie(request, cookie.name),
      rawQuery: rawQuery(request),
    });
    reply.header('set-cookie', `${cookie.name}=; Max-Age=0; ${attributes}`);
    if (outcome.kind === 'invalid') return plainError(reply);
    return redirect(reply, outcome.location);
  });
}
