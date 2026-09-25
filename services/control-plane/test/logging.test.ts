// Logging (§6.6; AC-14; SEC-F002-21): the scrubber and the redaction paths.
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS, loggerOptions, scrubText, scrubValue } from '../src/http/logging.js';
import { createJsonLogger } from '../src/observability/logger.js';
import { createPinoLogger, loggerFromPino } from '../src/observability/pino.js';
import { fakeRts } from './fixtures/fake-rts.js';

// Token-shaped fixtures are built at runtime from low-entropy filler, so the repository's own
// secret scanner doesn't read the test data as credentials; the scrubber patterns still match.
const filler = (n: number) => 'Ab1'.repeat(Math.ceil(n / 3)).slice(0, n);

describe('scrubber', () => {
  it.each([
    ['a JWT', 'token eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln rejected'],
    ['a JWT without signature', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.'],
    ['a refresh token', `got rly_rt_${filler(43)}`],
    ['an authorization code', `code=rly_ac_${filler(43)}`],
    ['an OpenBao token', `X-Vault-Token: hvs.${filler(32)}`],
    [
      'a client_secret form field',
      `grant_type=x&${['client', 'secret'].join('_')}=Sup3rS3cret&scope=y`,
    ],
    ['a code_verifier form field', 'code_verifier=abcDEF123-._~xyz'],
  ])('removes %s', (_name, text) => {
    const out = scrubText(text);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toMatch(/Sup3rS3cret|rly_(rt|ac)_Ab1|hvs\.Ab1|eyJzdWIi|abcDEF123/);
  });

  it('keeps the scheme and host of a URL with credentials', () => {
    expect(scrubText('connect postgres://ralysa_cp_app:p4ss@db:5432/ralysa failed')).toBe(
      'connect postgres://ralysa_cp_app:[REDACTED]@db:5432/ralysa failed',
    );
  });

  it('leaves ordinary text and ids alone', () => {
    const text = 'user 0192f0a0-7b3c-7d4e-8f00-0000000000aa signed in via idp_device';
    expect(scrubText(text)).toBe(text);
  });

  it('scrubs nested values of a log record', () => {
    expect(
      scrubValue({
        err: {
          message: 'bad eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.x',
          stack: ['rly_rt_abcdefghijklmnop'],
        },
      }),
    ).toEqual({ err: { message: 'bad [REDACTED]', stack: ['[REDACTED]'] } });
  });
});

describe('logger options', () => {
  it('redacts credential headers and body fields', () => {
    for (const path of [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-vault-token"]',
      'body.code',
      'body.code_verifier',
      'body.refresh_token',
      'body.client_assertion',
      'body.subject_token',
      'body.state',
    ]) {
      expect(REDACT_PATHS).toContain(path);
    }
  });

  it('serializers never emit raw requests, responses, email or display name', () => {
    const options = loggerOptions('info');
    const serializers = options.serializers as Record<string, (value: unknown) => unknown>;
    expect(
      serializers.req?.({ url: '/x?code=1', headers: { authorization: 'Bearer x' } }),
    ).toBeUndefined();
    expect(serializers.res?.({ statusCode: 200 })).toBeUndefined();
    const err = serializers.err?.(
      Object.assign(new Error('user a@b.qa rly_rt_abcdefghijklmnop'), { code: 'X' }),
    );
    expect(err).toEqual({
      type: 'Error',
      message: 'user a@b.qa [REDACTED]',
      error_code: 'X',
      status: undefined,
    });
    expect(JSON.stringify(err)).not.toMatch(/display_name|email/);
  });
});

describe('review of #25: every line is scrubbed', () => {
  const jwt = `eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.${filler(20)}`;

  it('the message string is scrubbed, not only the fields', () => {
    const lines: string[] = [];
    const log = createPinoLogger('info', { write: (line: string) => lines.push(line) });
    log.info(`token was ${jwt}`);
    log.info({ note: 'x' }, `refresh rly_rt_${filler(43)}`);
    expect(lines.join('')).not.toMatch(/eyJzdWIi|rly_rt_Ab1/);
    expect(lines.join('')).toContain('[REDACTED]');
  });

  it('values nested beyond the scrub depth are redacted as a whole', () => {
    let deep: Record<string, unknown> = { token: jwt };
    for (let i = 0; i < 12; i++) deep = { next: deep };
    expect(JSON.stringify(scrubValue(deep))).not.toContain('eyJ');
    expect(JSON.stringify(scrubValue(deep))).toContain('[REDACTED:depth]');
  });

  it('the Logger port used by the key watcher, spool and start-up goes through the same pino rules', () => {
    const lines: string[] = [];
    const logger = loggerFromPino(
      createPinoLogger('info', { write: (line: string) => lines.push(line) }),
    );
    logger.error(`describe failed for ${jwt}`, {
      error: `postgres://u:${filler(12)}@db/ralysa`,
      body: { code: 'x' },
    });
    const out = lines.join('');
    expect(out).not.toMatch(/eyJzdWIi|Ab1Ab1Ab1Ab1@/);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ body: { code: '[REDACTED]' } });
  });

  it('the one-shot entry points (JSON logger) scrub message and fields too', () => {
    const lines: string[] = [];
    const logger = createJsonLogger((line) => lines.push(line));
    logger.warn(`bad ${jwt}`, { detail: `hvs.${filler(30)}` });
    expect(lines.join('')).not.toMatch(/eyJzdWIi|hvs\.Ab1/);
  });
});

describe('re-review of #25: interpolation cannot escape scrubbing', () => {
  it('app.log.info({}, "interp %o", …) and %j/%s are scrubbed in the final line', async () => {
    const lines: string[] = [];
    const { buildApp } = await import('../src/app.js');
    const { fakeKeys } = await import('./fixtures/fake-keys.js');
    const { serveConfig } = await import('./fixtures/serve-config.js');
    const app = await buildApp({
      config: serveConfig(),
      keys: (await fakeKeys()).keys,
      rts: fakeRts(),
      pingDatabase: () => Promise.resolve(true),
      logger: createPinoLogger('info', { write: (line: string) => lines.push(line) }),
    });
    const tok = `rly_rt_${filler(43)}`;
    app.log.info({}, 'interp %o', { tok });
    app.log.info('json %j', { tok });
    app.log.info('str %s', tok);
    const out = lines.join('');
    expect(out).not.toContain('rly_rt_Ab1');
    expect(out.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('review of #26: errors logged through a Fastify request logger', () => {
  it('keep their type and scrubbed message; the serializer never throws', async () => {
    const { default: Fastify } = await import('fastify');
    const lines: string[] = [];
    const app = Fastify({
      loggerInstance: createPinoLogger('info', { write: (line: string) => lines.push(line) }),
    });
    const { handleError } = await import('../src/http/errors.js');
    app.setErrorHandler((error, request, reply) => handleError(error, request, reply));
    app.get('/oauth2/x', () => {
      const error = new Error(`boom rly_rt_${filler(43)}`) as Error & { code: string };
      error.name = 'SigningUnavailableError';
      error.code = 'E_SIGN';
      throw error;
    });
    app.get('/x', (request) => {
      request.log.error({ err: new Error('plain') }, 'err_key'); // Fastify/pino path: must not throw
      return 'ok';
    });
    const reply = await app.inject('/oauth2/x');
    expect(reply.statusCode).toBe(503);
    expect(reply.json()).toEqual({ error: 'temporarily_unavailable' });
    expect((await app.inject('/x')).statusCode).toBe(200);
    const unhandled = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.msg === 'unhandled_error');
    expect(unhandled?.error).toEqual({
      type: 'SigningUnavailableError',
      message: 'boom [REDACTED]',
      error_code: 'E_SIGN',
    });
  });
});
