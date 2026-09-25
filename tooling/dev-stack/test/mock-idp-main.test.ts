// F-002-T09: the mock IdP's process entry point (compose `mock-idp`, `cli.ts mock-idp`).
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEV_IDS, MainEnv, controlCommand, runMockIdp } from '../src/mock-idp/main.ts';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MainEnv', () => {
  it('defaults to the dev ports and a loopback issuer', () => {
    const env = MainEnv.parse({});
    expect(env).toMatchObject({
      MOCK_IDP_HOST: '127.0.0.1',
      MOCK_IDP_PORT: 59_400,
      MOCK_IDP_CONTROL_PORT: 59_401,
      MOCK_IDP_PUBLIC_BASE_URL: 'http://127.0.0.1:59400',
    });
  });

  it('refuses a non-loopback public URL', () => {
    expect(() => MainEnv.parse({ MOCK_IDP_PUBLIC_BASE_URL: 'https://idp.example.com' })).toThrow(
      /loopback/,
    );
  });

  it('binds 0.0.0.0 only inside the dev container', () => {
    expect(() => MainEnv.parse({ MOCK_IDP_HOST: '0.0.0.0' })).toThrow(/loopback/);
    expect(
      MainEnv.parse({ MOCK_IDP_HOST: '0.0.0.0', MOCK_IDP_IN_CONTAINER: '1' }).MOCK_IDP_HOST,
    ).toBe('0.0.0.0');
  });
});

describe('runMockIdp', () => {
  it('uses the dev control-plane ids, writes the bearer 0600 (never logs it), and serves control', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mock-idp-'));
    dirs.push(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const tokenFile = join(dir, 'nested', 'control-token');
    const controlPort = 59_400 + Math.floor(Math.random() * 500) + 500;
    const env: MainEnv = {
      ...MainEnv.parse({}),
      MOCK_IDP_PORT: 0,
      MOCK_IDP_CONTROL_PORT: controlPort,
      MOCK_IDP_PUBLIC_BASE_URL: 'http://127.0.0.1:59400',
      MOCK_IDP_CONTROL_TOKEN_FILE: tokenFile,
    };
    const stop = await runMockIdp(env);
    try {
      const token = readFileSync(tokenFile, 'utf8');
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      const logged = log.mock.calls.flat().join('\n');
      expect(logged).toContain(`http://127.0.0.1:59400/${DEV_IDS.tenantId}/v2.0`);
      expect(logged).toContain('http://127.0.0.1:59400/graph');
      expect(logged).not.toContain(token);

      log.mockClear();
      expect(await controlCommand(env, ['GET', '/users'])).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toMatch(/^200 \[/);
      expect(await controlCommand(env, ['PATCH', '/users/nobody', '{"enabled":false}'])).toBe(1);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await controlCommand(env, ['TRACE', '/users'])).toBe(2);
    } finally {
      await stop();
    }
    expect(existsSync(tokenFile)).toBe(false);
  });
});
