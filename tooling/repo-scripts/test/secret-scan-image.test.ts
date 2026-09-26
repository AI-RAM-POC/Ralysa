// TC-F-002-14 (image part) and TC-F-002-35 (image part) (AC-9, T-12; SEC-F002-13 c, SEC-F002-29,
// AR-12; F-002-T14): `secret-scan image` finds a planted credential in the image filesystem and
// in its config and history, finds each exact value, refuses a root user and secret-named ENV or
// ARG, and finds the dev stack or oidc-provider in the image. Docker is replaced by a fake that
// serves a fixture image (its `export` is a tar of a fixture root filesystem); gitleaks is the
// real, hash-pinned binary. The real image is scanned by the CI `integration` job.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretScanError } from '../src/secret-scan.ts';
import { DEV_ONLY_PACKAGES } from '@ralysa/eslint-config/boundaries';
import {
  DEV_ONLY_IN_IMAGE,
  type Docker,
  type ImageConfig,
  SECRET_NAME,
  checkDevOnlyAbsent,
  checkImageConfig,
  devOnlyNamedIn,
  parseExactValues,
  scanDirectory,
  scanExactValues,
  scanImage,
} from '../src/secret-scan-image.ts';
import { canary, frag, randomFrom } from '../src/secret-scan-selftest.ts';
import { gitleaks, writeFile } from './gitleaks-bin.ts';
import { REAL_ROOT } from './repo-copy.ts';
import { makeTempDir } from './temp.ts';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const value = (): string => randomFrom(ALNUM, 40);
const ctx = () => ({ root: REAL_ROOT, binary: gitleaks(), reportDir: makeTempDir('ralysa-rep-') });

const APP_PACKAGE = JSON.stringify({
  name: '@ralysa/control-plane',
  dependencies: { fastify: '5.12.5' },
  devDependencies: { '@ralysa/dev-stack': 'workspace:*' },
});

function rootfs(files: Record<string, string>): string {
  const dir = makeTempDir('ralysa-rootfs-');
  for (const [path, text] of Object.entries(files)) writeFile(dir, path, text);
  return dir;
}

/** A fake `docker` serving one image: inspect, history, create, export (a tar of `fs`), rm. */
function fakeDocker(
  fs: string,
  config: ImageConfig,
  history: string[],
): Docker & { calls: string[] } {
  const calls: string[] = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const run: Docker = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    switch (args[0]) {
      case 'image':
        return args[1] === 'inspect' ? ok(JSON.stringify([{ Config: config }])) : ok();
      case 'history':
        return ok(`${history.join('\n')}\n`);
      case 'create':
        return ok('c0ffee\n');
      case 'export': {
        const output = args[args.indexOf('--output') + 1] as string;
        const tar = spawnSync('tar', ['-cf', output, '-C', fs, '.']);
        return tar.status === 0 ? ok() : { status: 1, stdout: '', stderr: 'tar failed' };
      }
      case 'rm':
        return ok();
      default:
        return { status: 1, stdout: '', stderr: `unexpected docker ${args.join(' ')}` };
    }
  };
  return Object.assign(run, { calls });
}

const CLEAN_CONFIG: ImageConfig = {
  User: '1000:1000',
  Env: ['PATH=/usr/local/bin:/usr/bin', 'NODE_VERSION=24.21.0', 'NODE_ENV=production'],
  WorkingDir: '/app',
  Entrypoint: ['node', 'dist/main.js'],
};
const CLEAN_HISTORY = [
  'CMD ["serve"]',
  'USER 1000:1000',
  'COPY --chown=root:root /out /app # buildkit',
  'ENV NODE_ENV=production',
];

describe('exact values', () => {
  it('parses KEY=VALUE lines, with comments, export and quotes', () => {
    const a = value();
    const b = value();
    expect(
      parseExactValues(`# dev stack\nPOSTGRES_PASSWORD=${a}\n\nexport TOKEN="${b}"\n`),
    ).toEqual([
      { key: 'POSTGRES_PASSWORD', value: a },
      { key: 'TOKEN', value: b },
    ]);
  });

  it('refuses a short value (it would match by chance), a malformed line and an empty file', () => {
    expect(() => parseExactValues('X=short')).toThrow(/shorter than 16/);
    expect(() => parseExactValues('not a pair')).toThrow(SecretScanError);
    expect(() => parseExactValues('# nothing\n')).toThrow(/no values/);
  });

  it('finds each value byte for byte and names only its key', () => {
    const secret = value();
    const dir = rootfs({
      'var/log/app.log': `{"msg":"x","dsn":"postgres://u:${secret}@db/x"}\n`,
      'etc/clean.txt': 'nothing here\n',
    });
    const findings = scanExactValues(dir, [{ key: 'DB_PASSWORD', value: secret }], 'test');
    expect(findings).toEqual([
      {
        rule: 'secret/exact-value',
        path: 'var/log/app.log',
        message: 'test: the value of DB_PASSWORD is in this file (value redacted)',
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain(secret);
  });
});

describe('dev-only exclusion (TC-F-002-35, SEC-F002-13 c)', () => {
  it('a clean application tree passes; devDependencies in manifests are not installs', () => {
    const fs = rootfs({
      'app/package.json': APP_PACKAGE,
      'app/node_modules/.pnpm/openid-client@6.8.8/node_modules/openid-client/package.json':
        JSON.stringify({ name: 'openid-client', devDependencies: { 'oidc-provider': '9.0.0' } }),
      'app/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    });
    expect(checkDevOnlyAbsent(fs, '/app')).toEqual([]);
  });

  it.each([
    [
      'oidc-provider in the pnpm virtual store',
      'app/node_modules/.pnpm/oidc-provider@9.11.5/node_modules/oidc-provider/lib/index.js',
    ],
    ['oidc-provider hoisted', 'app/node_modules/oidc-provider/package.json'],
    ['the dev stack linked in', 'app/node_modules/@ralysa/dev-stack/dist/index.js'],
    [
      'the dev stack in the virtual store',
      `app/node_modules/.pnpm/${frag('@ralysa', '+dev-stack')}@file+tooling+dev-stack/x.js`,
    ],
    ['oidc-provider outside the application', 'usr/lib/node_modules/oidc-provider/index.js'],
  ])('fails on %s', (_, path) => {
    const fs = rootfs({ 'app/package.json': APP_PACKAGE, [path]: '{}' });
    expect(checkDevOnlyAbsent(fs, '/app').map((f) => f.rule)).toEqual(['image/dev-only']);
  });

  it('fails on a production dependency or a lockfile entry naming either package', () => {
    expect(
      devOnlyNamedIn('package.json', JSON.stringify({ dependencies: { 'oidc-provider': '9' } })),
    ).toEqual(['oidc-provider']);
    expect(devOnlyNamedIn('x/package.json', JSON.stringify({ name: '@ralysa/dev-stack' }))).toEqual(
      ['@ralysa/dev-stack'],
    );
    expect(devOnlyNamedIn('pnpm-lock.yaml', '  oidc-provider@9.11.5:\n')).toEqual([
      'oidc-provider',
    ]);
    expect(
      devOnlyNamedIn('package.json', JSON.stringify({ devDependencies: { 'oidc-provider': '9' } })),
    ).toEqual([]);
  });

  it('the positive control fails when the working directory holds no application', () => {
    const fs = rootfs({ 'srv/package.json': APP_PACKAGE });
    expect(checkDevOnlyAbsent(fs, '/app').map((f) => f.rule)).toEqual(['image/positive-control']);
    expect(checkDevOnlyAbsent(fs, '').map((f) => f.rule)).toEqual(['image/positive-control']);
  });
});

describe('shared lists (R34-n2, R34-n3)', () => {
  it('DEV_ONLY_IN_IMAGE is boundaries.js DEV_ONLY_PACKAGES (a dependency-free copy)', () => {
    expect([...DEV_ONLY_IN_IMAGE]).toEqual(DEV_ONLY_PACKAGES);
  });

  it.each([
    'IDP_CLIENT_SECRET',
    'DB_PASSWORD',
    'PASSWORD_FILE',
    'NPM_TOKEN',
    'SIGNING_KEY',
    'KEY',
    'KEY_FILE',
    'AUDIT-HMAC-KEY',
    'API_KEY',
    'APIKEY',
    'PRIVATE_PEM',
    'BAO_ROLE_ID',
    'AZURE_CREDENTIALS',
  ])('SECRET_NAME matches %s', (name) => {
    expect(SECRET_NAME.test(name)).toBe(true);
  });

  it.each([
    'PATH',
    'NODE_VERSION',
    'YARN_VERSION',
    'NODE_ENV',
    'MONKEY',
    'KEYBOARD_LAYOUT',
    'HOME',
  ])('SECRET_NAME does not match %s', (name) => {
    expect(SECRET_NAME.test(name)).toBe(false);
  });
});

describe('image config and history (SEC-F002-29)', () => {
  it('passes a non-root image with no secret-named ENV or ARG', () => {
    expect(checkImageConfig(CLEAN_CONFIG, CLEAN_HISTORY)).toEqual([]);
  });

  it.each([[''], ['root'], ['0'], ['0:0'], ['1000:0'], ['root:node']])(
    'refuses User "%s"',
    (user) => {
      expect(checkImageConfig({ ...CLEAN_CONFIG, User: user }, []).map((f) => f.rule)).toEqual([
        'image/root-user',
      ]);
    },
  );

  it('refuses a secret-named ENV and a secret-named build ARG, in either history form', () => {
    const findings = checkImageConfig(
      {
        ...CLEAN_CONFIG,
        Env: [...(CLEAN_CONFIG.Env ?? []), 'IDP_CLIENT_SECRET=x', 'DB_PASSWORD=y'],
      },
      [
        'ARG NPM_TOKEN=abc',
        '|2 BAO_SECRET_ID=abc BUILD=1 /bin/sh -c pnpm install # buildkit',
        'RUN /bin/sh -c echo ok',
      ],
    );
    expect(findings.map((f) => `${f.rule} ${f.path}`)).toEqual([
      'image/secret-env Config.Env IDP_CLIENT_SECRET',
      'image/secret-env Config.Env DB_PASSWORD',
      'image/secret-arg history[0] NPM_TOKEN',
      'image/secret-arg history[1] BAO_SECRET_ID',
    ]);
  });
});

describe('scanImage (TC-F-002-14 image part)', () => {
  it('a clean image passes every check, and the container is removed', () => {
    const fs = rootfs({ 'app/package.json': APP_PACKAGE, 'app/dist/main.js': 'export {};\n' });
    const run = fakeDocker(fs, CLEAN_CONFIG, CLEAN_HISTORY);
    const envFile = join(makeTempDir('ralysa-env-'), '.env');
    writeFileSync(envFile, `POSTGRES_PASSWORD=${value()}\n`);
    const result = scanImage({
      ctx: ctx(),
      image: 'fixture:1',
      exactValuesFile: envFile,
      docker: run,
    });
    expect(result.findings).toEqual([]);
    expect(result.results.map((r) => [r.label, r.findings.length])).toEqual([
      ['image-filesystem', 0],
      ['image-config-history', 0],
    ]);
    expect(run.calls).toContain('rm -f');
  });

  it('finds a credential in the filesystem, one in the config, an exact value, and oidc-provider', () => {
    const leaked = value();
    const fs = rootfs({
      'app/package.json': APP_PACKAGE,
      'app/dist/config.js': `export const k = "${canary()}";\n`,
      'app/dist/leak.js': `export const dsn = "postgres://u:${leaked}@db";\n`,
      'app/node_modules/.pnpm/oidc-provider@9.11.5/node_modules/oidc-provider/package.json': '{}',
    });
    const config = {
      ...CLEAN_CONFIG,
      Env: [...(CLEAN_CONFIG.Env ?? []), `BUILD_INFO=${canary()}`],
    };
    const history = [...CLEAN_HISTORY, `LABEL note=${leaked}`];
    const envFile = join(makeTempDir('ralysa-env-'), '.env');
    writeFileSync(envFile, `POSTGRES_PASSWORD=${leaked}\n`);
    const result = scanImage({
      ctx: ctx(),
      image: 'fixture:2',
      exactValuesFile: envFile,
      docker: fakeDocker(fs, config, history),
    });
    const [filesystem, meta] = result.results;
    expect(filesystem?.findings.map((f) => `${f.rule} ${f.file}`)).toEqual([
      'ralysa-selftest-canary app/dist/config.js',
    ]);
    expect(meta?.findings.map((f) => `${f.rule} ${f.file}`)).toEqual([
      'ralysa-selftest-canary image-config.json',
    ]);
    expect(result.findings.map((f) => `${f.rule} ${f.path}`).sort()).toEqual([
      'image/dev-only /app/node_modules/.pnpm/oidc-provider@9.11.5',
      'secret/exact-value app/dist/leak.js',
      'secret/exact-value image-history.txt',
    ]);
    expect(JSON.stringify(result)).not.toContain(leaked);
  });

  it('builds from a Dockerfile, then removes the scan tag', () => {
    const fs = rootfs({ 'app/package.json': APP_PACKAGE });
    const run = fakeDocker(fs, CLEAN_CONFIG, CLEAN_HISTORY);
    const calls: string[][] = [];
    const recording: Docker = (args, options) => {
      calls.push(args);
      return args[0] === 'build' ? { status: 0, stdout: '', stderr: '' } : run(args, options);
    };
    const result = scanImage({
      ctx: ctx(),
      dockerfile: 'deploy/docker/x.Dockerfile',
      docker: recording,
    });
    expect(result.image).toMatch(/^ralysa-secret-scan:[0-9a-f]{12}$/);
    expect(calls[0]).toEqual([
      'build',
      '-f',
      'deploy/docker/x.Dockerfile',
      '-t',
      result.image,
      REAL_ROOT,
    ]);
    expect(calls.at(-1)).toEqual(['image', 'rm', '-f', result.image]);
  });

  it('a failed docker call is a scanner error, not a pass', () => {
    const failing: Docker = () => ({ status: 1, stdout: '', stderr: 'no such image' });
    expect(() => scanImage({ ctx: ctx(), image: 'missing:1', docker: failing })).toThrow(
      /docker image inspect failed/,
    );
  });
});

describe('scanDirectory (DB dumps, logs, deploy/**)', () => {
  it('reports gitleaks findings and exact values; an empty folder is refused', () => {
    const secret = value();
    const dir = rootfs({ 'dump.sql': `COPY x FROM stdin;\n${canary()}\t${secret}\n` });
    const envFile = join(makeTempDir('ralysa-env-'), 'values');
    writeFileSync(envFile, `IDP_CLIENT_SECRET=${secret}\n`);
    const scanned = scanDirectory(ctx(), dir, envFile);
    expect(scanned.results[0]?.findings.map((f) => f.rule)).toEqual(['ralysa-selftest-canary']);
    expect(scanned.findings.map((f) => f.message)).toEqual([
      'dir: the value of IDP_CLIENT_SECRET is in this file (value redacted)',
    ]);
    expect(() => scanDirectory(ctx(), makeTempDir('ralysa-empty-'))).toThrow(/holds no files/);
    expect(existsSync(dir)).toBe(true);
  });
});
