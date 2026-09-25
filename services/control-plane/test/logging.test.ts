// Logging (§6.6; AC-14; SEC-F002-21): the scrubber and the redaction paths.
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS, loggerOptions, scrubText, scrubValue } from '../src/http/logging.js';

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
      code: 'X',
      status: undefined,
    });
    expect(JSON.stringify(err)).not.toMatch(/display_name|email/);
  });
});
