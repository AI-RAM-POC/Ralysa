// F-002-T09: the mock IdP's process entry point (compose `mock-idp`, `cli.ts mock-idp`).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEV_IDS,
  MainEnv,
  controlCommand,
  ensurePrivateDir,
  parseMainEnv,
  runMockIdp,
} from '../src/mock-idp/main.ts';

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

  it('binds 0.0.0.0 only inside a real container: the flag alone is not enough', () => {
    expect(() => parseMainEnv({ MOCK_IDP_HOST: '0.0.0.0' }, false)).toThrow(/loopback/);
    expect(() => parseMainEnv({ MOCK_IDP_HOST: '0.0.0.0' }, true)).toThrow(/loopback/);
    expect(() =>
      parseMainEnv({ MOCK_IDP_HOST: '0.0.0.0', MOCK_IDP_IN_CONTAINER: '1' }, false),
    ).toThrow(/loopback/);
    expect(
      parseMainEnv({ MOCK_IDP_HOST: '0.0.0.0', MOCK_IDP_IN_CONTAINER: '1' }, true).MOCK_IDP_HOST,
    ).toBe('0.0.0.0');
  });
});

describe('ensurePrivateDir', () => {
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mock-idp-dir-'));
    dirs.push(dir);
    return dir;
  };

  it('creates the directory 0700', () => {
    const dir = join(scratch(), 'a', 'b');
    ensurePrivateDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses an existing directory that others can read', () => {
    const dir = join(scratch(), 'shared');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    expect(() => {
      ensurePrivateDir(dir);
    }).toThrow(/0700/);
  });

  it('refuses a symlink in place of the directory', () => {
    const root = scratch();
    const target = join(root, 'target');
    mkdirSync(target, { mode: 0o700 });
    const link = join(root, 'link');
    symlinkSync(target, link);
    expect(() => {
      ensurePrivateDir(link);
    }).toThrow(/0700/);
  });
});

describe('runMockIdp', () => {
  it('uses the dev control-plane ids, writes the bearer 0600 (never logs it), and serves control', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mock-idp-'));
    dirs.push(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const tokenFile = join(dir, 'nested', 'control-token');
    const env: MainEnv = {
      ...MainEnv.parse({}),
      MOCK_IDP_PORT: 0,
      MOCK_IDP_CONTROL_PORT: 0,
      MOCK_IDP_PUBLIC_BASE_URL: 'http://127.0.0.1:59400',
      MOCK_IDP_CONTROL_TOKEN_FILE: tokenFile,
    };
    const { stop, controlPort } = await runMockIdp(env);
    const bound: MainEnv = { ...env, MOCK_IDP_CONTROL_PORT: controlPort };
    expect(controlPort).toBeGreaterThan(0);
    try {
      const token = readFileSync(tokenFile, 'utf8');
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      const logged = log.mock.calls.flat().join('\n');
      expect(logged).toContain(`http://127.0.0.1:59400/${DEV_IDS.tenantId}/v2.0`);
      expect(logged).toContain('http://127.0.0.1:59400/graph');
      expect(logged).not.toContain(token);

      log.mockClear();
      expect(await controlCommand(bound, ['GET', '/users'])).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toMatch(/^200 \[/);
      expect(await controlCommand(bound, ['PATCH', '/users/nobody', '{"enabled":false}'])).toBe(1);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await controlCommand(bound, ['TRACE', '/users'])).toBe(2);
    } finally {
      await stop();
    }
    expect(existsSync(tokenFile)).toBe(false);
  });
});
