// application/x-www-form-urlencoded for the OAuth endpoints (RFC 6749 §3.2, RFC 7009 §2.1),
// without a plugin. A parameter may appear once (RFC 6749 §3.1); a repeated one is refused.
import type { FastifyInstance } from 'fastify';
import { OAuthProblem } from './errors.js';

export function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(body)) {
    if (Object.hasOwn(out, name)) {
      throw new OAuthProblem({
        error: 'invalid_request',
        error_description: `repeated parameter ${name}`,
      });
    }
    out[name] = value;
  }
  return out;
}

export function registerFormParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 16 * 1024 },
    (_request, body, done) => {
      try {
        done(null, parseForm(body as string));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );
}
